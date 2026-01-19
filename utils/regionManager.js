const RegionStats = require("../models/RegionStats");

const REGION_LIST = [
  process.env.AWS_REGION_EAST2,
  process.env.AWS_REGION_WEST1,
  process.env.AWS_REGION_AP,
];

const BOUNCE_THRESHOLD = 4.5;

async function getActiveRegion() {
  let stats = await RegionStats.findOne().sort({ lastSwitched: -1 });

  if (!stats) {
    return (await RegionStats.create({ region: REGION_LIST[0] })).region;
  }

  const bounceRate = (stats.bounced / (stats.sent || 1)) * 100;

  if (bounceRate >= BOUNCE_THRESHOLD) {
    const currentIndex = REGION_LIST.indexOf(stats.region);
    const nextRegion = REGION_LIST[(currentIndex + 1) % REGION_LIST.length];
    console.log(`⚠️ Bounce rate ${bounceRate}% exceeded. Switching to ${nextRegion}`);
    stats = await RegionStats.create({ region: nextRegion });
  }

  return stats.region;
}

async function incrementSent(region) {
  await RegionStats.updateOne({ region }, { $inc: { sent: 1 } });
}

async function incrementBounce(region) {
  await RegionStats.updateOne({ region }, { $inc: { bounced: 1 } });
}

module.exports = {
  getActiveRegion,
  incrementSent,
  incrementBounce
};
