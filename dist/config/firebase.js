"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.admin = void 0;
exports.initFirebase = initFirebase;
exports.verifyFirebaseToken = verifyFirebaseToken;
const firebase_admin_1 = __importDefault(require("firebase-admin"));
exports.admin = firebase_admin_1.default;
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
let firebaseApp = null;
function initFirebase() {
    if (firebaseApp)
        return firebaseApp;
    if (!env_1.env.FIREBASE_PROJECT_ID || env_1.env.FIREBASE_PROJECT_ID === 'your-firebase-project-id') {
        logger_1.logger.warn('Firebase not configured — phone/Google auth will be unavailable');
        return {};
    }
    const privateKey = env_1.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    firebaseApp = firebase_admin_1.default.initializeApp({
        credential: firebase_admin_1.default.credential.cert({
            projectId: env_1.env.FIREBASE_PROJECT_ID,
            privateKey,
            clientEmail: env_1.env.FIREBASE_CLIENT_EMAIL,
        }),
    });
    logger_1.logger.info('Firebase Admin initialized');
    return firebaseApp;
}
async function verifyFirebaseToken(idToken) {
    if (!firebaseApp) {
        throw new Error('Firebase not initialized');
    }
    return firebase_admin_1.default.auth().verifyIdToken(idToken);
}
