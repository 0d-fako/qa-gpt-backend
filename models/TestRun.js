const mongoose = require('mongoose');

const TestStepSchema = new mongoose.Schema({
  index: Number,
  description: String,
  status: { type: String, enum: ['PASS', 'FAIL', 'PENDING'] },
  timestamp: Date,
  durationMs: Number,
  screenshot: String,
  log: String,
  error: String,
  locator: String,
  networkLogs: [{
    url: String,
    method: String,
    status: Number,
    timestamp: Date,
    timeMs: Number
  }]
});

const TestCaseResultSchema = new mongoose.Schema({
  id: String,
  title: String,
  type: String,
  priority: String,
  status: { type: String, enum: ['PASS', 'FAIL', 'PENDING'] },
  executedSteps: [TestStepSchema],
  summary: {
    passed: Number,
    failed: Number,
    total: Number
  }
});

const TestRunSchema = new mongoose.Schema({
  // Metadata
  runId: { type: String, required: true, unique: true },
  projectId: String,
  userId: String,

  // Configuration
  url: { type: String, required: true },
  config: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // Results
  testCases: [TestCaseResultSchema],

  // Summary
  summary: {
    total: Number,
    passed: Number,
    failed: Number,
    pending: Number,
    duration: Number // Total execution time in ms
  },

  // Timestamps
  startedAt: { type: Date, required: true },
  completedAt: Date,

  // Status
  status: {
    type: String,
    enum: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
    default: 'RUNNING'
  },

  // Error info if run failed
  error: String
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// Indexes for performance
TestRunSchema.index({ runId: 1 });
TestRunSchema.index({ userId: 1, createdAt: -1 }); // User's recent runs
TestRunSchema.index({ projectId: 1, createdAt: -1 }); // Project history
TestRunSchema.index({ status: 1 });

module.exports = mongoose.model('TestRun', TestRunSchema);