// models/DashStat.js
const mongoose = require("mongoose");

const DashStatSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true, unique: true },
  single: { valid: {type:Number,default:0}, invalid:{type:Number,default:0}, risky:{type:Number,default:0}, unknown:{type:Number,default:0}, requests:{ type: Number, default: 0 }, },
  bulk:   { valid: {type:Number,default:0}, invalid:{type:Number,default:0}, risky:{type:Number,default:0}, unknown:{type:Number,default:0}, requests:{ type: Number, default: 0 }, },
}, { timestamps: true });

module.exports = mongoose.model("DashStat", DashStatSchema);
