const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const { requireAgent } = require("../middleware/authMiddleware");
const {
  heartbeat,
  agentOffline,
  nextJob,
  downloadJobFile,
  updateJobStatus
} = require("../controllers/agentController");

router.use(requireAgent);
router.post("/heartbeat", asyncHandler(heartbeat));
router.post("/offline", asyncHandler(agentOffline));
router.get("/jobs/next", asyncHandler(nextJob));
router.get("/jobs/:id/file", asyncHandler(downloadJobFile));
router.patch("/jobs/:id/status", asyncHandler(updateJobStatus));

module.exports = router;
