
// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // username and email are distinct now
    username:  { type: String, required: true, unique: true, trim: true },
    email:     { type: String, required: true, unique: true, lowercase: true, trim: true },

    password:  { type: String, required: true },
    firstName: { type: String },
    lastName:  { type: String },

    permissions: { type: [String], default: ["single", "bulk"] },
    credits:   { type: Number, default: 100 },
    singleTimestamp: { type: Date, default: null },
    lastPasswordUpdate: { type: Date, default: null },
  },
  { timestamps: true, collection: "users" } 
);

module.exports = mongoose.model("User", userSchema);

