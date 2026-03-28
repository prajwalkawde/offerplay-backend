"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.qs = qs;
/** Extract a single string from Express query params (string | string[] | ParsedQs | ...) */
function qs(val) {
    if (val === undefined || val === null)
        return undefined;
    if (typeof val === 'string')
        return val;
    if (Array.isArray(val))
        return qs(val[0]);
    return undefined;
}
