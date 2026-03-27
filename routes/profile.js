// routes/profile.js
const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User");

const router = express.Router();

function isStrongPassword(password) {
  const value = String(password || "");
  const hasMinLength = value.length >= 8;
  const hasUppercase = /[A-Z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSpecial = /[!@#$%^&*()\-_=+[{\]}\\|;:'",<.>/?`~]/.test(value);

  return hasMinLength && hasUppercase && hasDigit && hasSpecial;
}

/* -------------------------------------------------------
   helper: get username from request
   frontend will send x-username header
------------------------------------------------------- */
function getUsernameFromRequest(req) {
  return String(
    req.headers["x-username"] ||
      req.body?.username ||
      req.query?.username ||
      "",
  ).trim();
}

function buildUserDbName(username) {
  return `${String(username || "").trim()}-emailTool`;
}

/* -------------------------------------------------------
   middleware: find logged-in user by username
------------------------------------------------------- */
async function requireUserByUsername(req, res, next) {
  try {
    const username = getUsernameFromRequest(req);

    if (!username) {
      return res.status(401).json({
        ok: false,
        message: "Username missing. Please login again.",
      });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found.",
      });
    }

    req.authUser = user;
    next();
  } catch (err) {
    console.error("Profile auth error:", err);
    return res.status(500).json({
      ok: false,
      message: "Authentication failed.",
    });
  }
}

/* -------------------------------------------------------
   GET /api/profile
------------------------------------------------------- */
router.get("/", requireUserByUsername, async (req, res) => {
  try {
    const user = req.authUser;

    return res.status(200).json({
      ok: true,
      user: {
        _id: user._id,
        username: user.username || "",
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        email: user.email || "",
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
        credits: Number(user.credits || 0),
        creditsTotal: Number(user.credits || 0),
        creditsUsed: 0,
        billingModel: "Pay As You Go",
        singleTimestamp: user.singleTimestamp || null,
        lastPasswordUpdate: user.lastPasswordUpdate || null,
        lastLogin: user.lastLogin || null,
        createdAt: user.createdAt || null,
        updatedAt: user.updatedAt || null,
      },
    });
  } catch (err) {
    console.error("GET /api/profile error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to fetch profile.",
    });
  }
});

/* -------------------------------------------------------
   PUT /api/profile/reset-password
------------------------------------------------------- */
router.put("/reset-password", requireUserByUsername, async (req, res) => {
  try {
    const user = req.authUser;

    const {
      currentPassword = "",
      newPassword = "",
      confirmPassword = "",
    } = req.body || {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        ok: false,
        message:
          "Current password, new password, and confirm password are required.",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: "New password and confirm password do not match.",
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        ok: false,
        message:
          "New password must be at least 8 characters and include 1 uppercase letter, 1 number, and 1 special character.",
      });
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      String(currentPassword),
      user.password,
    );

    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        ok: false,
        message: "Current password is incorrect.",
      });
    }

    const isSameAsOld = await bcrypt.compare(
      String(newPassword),
      user.password,
    );

    if (isSameAsOld) {
      return res.status(400).json({
        ok: false,
        message: "New password cannot be the same as the current password.",
      });
    }

    const hashedPassword = await bcrypt.hash(String(newPassword), 10);

    user.password = hashedPassword;
    user.lastPasswordUpdate = new Date();

    await user.save();

    return res.status(200).json({
      ok: true,
      message: "Password updated successfully.",
      lastPasswordUpdate: user.lastPasswordUpdate,
    });
  } catch (err) {
    console.error("PUT /api/profile/reset-password error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to reset password.",
    });
  }
});

/* -------------------------------------------------------
   DELETE /api/profile/delete-account
------------------------------------------------------- */
router.delete("/delete-account", requireUserByUsername, async (req, res) => {
  let userDb;

  try {
    const user = req.authUser;
    const username = user.username;
    const userDbName = buildUserDbName(username);

    // connect to user's separate DB
    userDb = mongoose.connection.useDb(userDbName);

    // delete user's separate database
    await userDb.dropDatabase();

    // delete user record from main emailTool/users collection
    await User.deleteOne({ _id: user._id });

    return res.status(200).json({
      ok: true,
      message: "Account deleted successfully.",
    });
  } catch (err) {
    // if user DB does not exist, still try to delete user record
    if (
      err?.message &&
      (
        err.message.includes("ns not found") ||
        err.message.includes("Database names cannot be empty")
      )
    ) {
      try {
        const user = req.authUser;
        await User.deleteOne({ _id: user._id });

        return res.status(200).json({
          ok: true,
          message: "Account deleted successfully.",
        });
      } catch (deleteErr) {
        console.error("DELETE /api/profile/delete-account user delete fallback error:", deleteErr);
        return res.status(500).json({
          ok: false,
          message: "Failed to delete account.",
        });
      }
    }

    console.error("DELETE /api/profile/delete-account error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to delete account.",
    });
  }
});

module.exports = router;
