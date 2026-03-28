"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = validate;
exports.validateQuery = validateQuery;
const zod_1 = require("zod");
const response_1 = require("../utils/response");
function formatZodError(err) {
    // Zod v4 uses `issues`, Zod v3 uses `errors`
    const issues = err.issues
        ?? err.errors
        ?? [];
    return issues.map((e) => `${e.path.join('.')}: ${e.message}`);
}
function validate(schema) {
    return (req, res, next) => {
        try {
            schema.parse(req.body);
            next();
        }
        catch (err) {
            if (err instanceof zod_1.ZodError) {
                (0, response_1.error)(res, 'Validation failed', 422, formatZodError(err));
                return;
            }
            next(err);
        }
    };
}
function validateQuery(schema) {
    return (req, res, next) => {
        try {
            schema.parse(req.query);
            next();
        }
        catch (err) {
            if (err instanceof zod_1.ZodError) {
                (0, response_1.error)(res, 'Validation failed', 422, formatZodError(err));
                return;
            }
            next(err);
        }
    };
}
