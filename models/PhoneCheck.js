// // // models/PhoneCheck.js
// // const mongoose = require("mongoose");

// // const PhoneCheckSchema = new mongoose.Schema(
// //   {
// //     userId: {
// //       type: mongoose.Schema.Types.ObjectId,
// //       ref: "User",
// //       required: true,
// //     },

// //     // raw input user typed
// //     inputNumber: { type: String, required: true },

// //     // optional: dropdown country (for global usage)
// //     inputCountry: { type: String },

// //     // normalized E.164 from Twilio
// //     e164: { type: String },

// //     // country code detected by Twilio ("IN", "US", etc.)
// //     country: { type: String },

// //     // "Airtel", "AT&T", etc.
// //     carrier: { type: String },

// //     // "mobile", "landline", "voip", etc.
// //     lineType: { type: String },

// //     // CNAM / Caller name
// //     callerName: { type: String },

// //     // "BUSINESS", "CONSUMER", "UNDETERMINED"
// //     ownerType: { type: String },

// //     // did Twilio think it's a valid number format?
// //     valid: { type: Boolean, default: false },

// //     // optional: raw Twilio payload (for debugging / analytics)
// //     raw: { type: Object },

// //     // our scoring
// //     leadQualityScore: { type: Number, default: null }, // 0–100
// //     leadQualityBand: {
// //       type: String,
// //       enum: ["high", "medium", "low", null],
// //       default: null,
// //     },
// //   },
// //   {
// //     timestamps: true, // createdAt, updatedAt
// //   }
// // );

// // module.exports = mongoose.model("PhoneCheck", PhoneCheckSchema);



// // models/PhoneCheck.js
// const mongoose = require("mongoose");

// const PhoneCheckSchema = new mongoose.Schema(
//   {
//     userId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       required: true,
//     },

//     // raw input user typed
//     inputNumber: { type: String, required: true },

//     // optional: dropdown country (for global usage)
//     inputCountry: { type: String },

//     // normalized E.164 from Twilio
//     e164: { type: String },

//     // country code detected by Twilio ("IN", "US", etc.)
//     country: { type: String },

//     // "Airtel", "AT&T", etc.
//     carrier: { type: String },

//     // "mobile", "landline", "voip", etc.
//     lineType: { type: String },

//     // CNAM / Caller name
//     callerName: { type: String },

//     // "BUSINESS", "CONSUMER", "UNDETERMINED"
//     ownerType: { type: String },

//     // did Twilio think it's a valid number format?
//     valid: { type: Boolean, default: false },

//     // optional: raw Twilio payload (for debugging / analytics)
//     raw: { type: Object },

//     // our scoring
//     leadQualityScore: { type: Number, default: null }, // (raw points)
//     leadQualityPercentage: { type: Number, default: null }, // 0–100 (NEW)
//     leadQualityBand: {
//       type: String,
//       enum: ["high", "medium", "low", null],
//       default: null,
//     },
//   },
//   {
//     timestamps: true, // createdAt, updatedAt
//   }
// );

// module.exports = mongoose.model("PhoneCheck", PhoneCheckSchema);


// models/PhoneCheck.js
const mongoose = require("mongoose");

const PhoneCheckSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // raw input user typed
    inputNumber: { type: String, required: true },

    // optional: dropdown country (for global usage)
    inputCountry: { type: String },

    // normalized E.164 from Twilio
    e164: { type: String },

    // country code detected/used ("IN", "US", "CA", etc.)
    country: { type: String },

    // "Airtel", "AT&T", etc.
    carrier: { type: String },

    // "mobile", "landline", "voip", etc.
    lineType: { type: String },

    // CNAM / Caller name
    callerName: { type: String },

    // "BUSINESS", "CONSUMER", "UNDETERMINED"
    ownerType: { type: String },

    // did Twilio think it's a valid number format?
    valid: { type: Boolean, default: false },

    // optional: raw Twilio payload (for debugging / analytics)
    raw: { type: Object },

    // internal debug message (NOT shown in UI)
    msg: { type: String, default: null },

    // our scoring
    leadQualityScore: { type: Number, default: null }, // (raw points)
    leadQualityPercentage: { type: Number, default: null }, // 0–100
    leadQualityBand: {
      type: String,
      enum: ["high", "medium", "low", null],
      default: null,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

module.exports = mongoose.model("PhoneCheck", PhoneCheckSchema);
