import { Router } from "express";
import { runNsectEngine } from "../core/engine.js";
import { requestValidationToHttp, normalizeEngineRequest } from "../core/request.js";
import { recordEngineOutcome } from "../observability/metrics.js";
import { getRuntimeConfig } from "../core/config.js";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const params = normalizeEngineRequest(req.body, {
      allowFileOutput: false,
      allowHeadful: false,
    });
    // Pass the solver config (from runtime env) into the engine so it can
    // attempt interactive-challenge solving when configured.
    const { solver } = getRuntimeConfig();
    const result = await runNsectEngine({ ...params, solver });

    if (!result.success) {
      const statusByErrorCode = {
        BROWSER_LAUNCH: 503,
        UPSTREAM_REQUEST: 502,
        CHALLENGE_BLOCKED: 502,
      };
      return res.status(statusByErrorCode[result.errorCode] || 500).json({
        error: result.error,
        code: result.errorCode || "ENGINE_ERROR",
      });
    }

    recordEngineOutcome(result);
    return res.json(result);
  } catch (err) {
    const validationResponse = requestValidationToHttp(err);
    if (validationResponse) {
      return res.status(validationResponse.status).json(validationResponse.body);
    }
    return res.status(500).json({ error: err.message });
  }
});

export default router;
