const express = require("express");

module.exports = function dbDeleteRouter(deps) {
  const router = express.Router();

  const {
    mongoose,
    EmailLog,
    SinglePending,
    SendGridPending,
    User,
    getUserDb,
    RegionStat,
    DomainReputation,
  } = deps;

  const ALLOWED_ADMIN_EMAILS = new Set([
    "yashwardhan.s@demandmediabpm.com",
    "saurabh.s@demandmediabpm.com",
  ]);

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function norm(v) {
    return String(v || "").trim().toLowerCase();
  }

  function isAllowedAdmin(req) {
    const headerEmail = norm(req.headers["x-user-email"] || req.headers["x-email"]);
    const bodyEmail = norm(req.body?.requesterEmail);
    const requesterEmail = headerEmail || bodyEmail;
    return ALLOWED_ADMIN_EMAILS.has(requesterEmail);
  }

  function getTargetEmail(req) {
    return norm(req.body?.email);
  }

  async function deleteFromAllUserDbs(targetEmail) {
    const users = await User.find({}, { username: 1, _id: 0 }).lean();
    const perUserResults = [];
    let totalUserEmailLogDeleted = 0;

    for (const u of users) {
      const username = String(u.username || "").trim();
      if (!username) continue;

      try {
        const { EmailLog: UserEmailLog } = getUserDb(
          mongoose,
          EmailLog,
          RegionStat,
          DomainReputation,
          username
        );

        const del = await UserEmailLog.deleteMany({ email: targetEmail });
        const deletedCount = Number(del?.deletedCount || 0);

        totalUserEmailLogDeleted += deletedCount;
        perUserResults.push({
          username,
          deletedEmailLogs: deletedCount,
          ok: true,
        });
      } catch (err) {
        perUserResults.push({
          username,
          deletedEmailLogs: 0,
          ok: false,
          error: err.message,
        });
      }
    }

    return { perUserResults, totalUserEmailLogDeleted };
  }

  router.post("/db-delete/email", async (req, res) => {
    try {
      if (!isAllowedAdmin(req)) {
        return res.status(403).json({
          ok: false,
          error: "Forbidden: you are not allowed to access DB Delete.",
        });
      }

      const targetEmail = getTargetEmail(req);
      if (!targetEmail || !EMAIL_REGEX.test(targetEmail)) {
        return res.status(400).json({
          ok: false,
          error: "A valid target email is required.",
        });
      }

      const [globalEmailLogDel, singlePendingDel, sendGridPendingDel] =
        await Promise.all([
          EmailLog.deleteMany({ email: targetEmail }),
          SinglePending.deleteMany({ email: targetEmail }),
          SendGridPending.deleteMany({ email: targetEmail }),
        ]);

      const { perUserResults, totalUserEmailLogDeleted } =
        await deleteFromAllUserDbs(targetEmail);

      const failedUsers = perUserResults.filter((x) => !x.ok).length;

      return res.json({
        ok: true,
        message:
          failedUsers > 0
            ? "Deletion completed with partial errors in some user DBs."
            : "Deletion completed successfully across global and all user DBs.",
        targetEmail,
        deleted: {
          global: {
            EmailLog: Number(globalEmailLogDel?.deletedCount || 0),
            SinglePending: Number(singlePendingDel?.deletedCount || 0),
            SendGridPending: Number(sendGridPendingDel?.deletedCount || 0),
          },
          allUsers: {
            userCount: perUserResults.length,
            failedUsers,
            EmailLogTotal: totalUserEmailLogDeleted,
          },
        },
        perUserResults,
      });
    } catch (err) {
      console.error("❌ /api/admin/db-delete/email error:", err);
      return res.status(500).json({
        ok: false,
        error: err.message || "Server error",
      });
    }
  });

  return router;
};
