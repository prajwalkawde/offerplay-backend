"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const homeController_1 = require("../controllers/homeController");
const router = (0, express_1.Router)();
router.use(auth_1.authMiddleware);
router.get('/', homeController_1.getHomeData);
exports.default = router;
