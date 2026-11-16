// Issues and verifies JWT session tokens (the tokens returned by
// POST /users/auth_token).  Persistent API tokens are not handled here.
//
// Keys are Ed25519 PEM files stored alongside the configuration:
//   <keys_dir>/jwt-<kid>.key  - private key, used to sign (active kid only)
//   <keys_dir>/jwt-<kid>.pub  - public key, used to verify
// keys_dir is resolved against the conf/ directory unless it is absolute.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as jose from "jose";
import SIS from "./constants.js";

var DEFAULT_CONF_DIR = path.join(import.meta.dirname, "..", "conf");
var KID_PATTERN = /^[A-Za-z0-9._-]+$/;
var PUB_FILE_PATTERN = /^jwt-([A-Za-z0-9._-]+)\.pub$/;
var JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function keyFileName(kid, ext) {
    return "jwt-" + kid + "." + ext;
}

function configError(msg) {
    return new Error("Invalid app." + SIS.OPT_JWT + " configuration: " + msg);
}

function assertEd25519(key, file) {
    if (key.asymmetricKeyType !== "ed25519") {
        throw configError(file + " is not an Ed25519 key (found " +
                          key.asymmetricKeyType + ")");
    }
}

function sameKey(a, b) {
    var fmt = { type : "spki", format : "der" };
    return a.export(fmt).equals(b.export(fmt));
}

// Resolve the effective settings from the raw app.jwt config
function resolveSettings(jwtConfig, confDir) {
    jwtConfig = jwtConfig || { };
    var activeKid = jwtConfig.active_kid || SIS.JWT_DEFAULT_KID;
    if (typeof activeKid !== "string" || !KID_PATTERN.test(activeKid)) {
        throw configError("active_kid must match " + KID_PATTERN);
    }
    var ttl = SIS.AUTH_EXPIRATION_TIME;
    if (jwtConfig.ttl_ms !== undefined) {
        ttl = Number(jwtConfig.ttl_ms);
        if (!Number.isInteger(ttl) || ttl < 1000) {
            throw configError("ttl_ms must be an integer >= 1000");
        }
    }
    var keysDir = jwtConfig.keys_dir || SIS.JWT_DEFAULT_KEYS_DIR;
    return {
        activeKid : activeKid,
        ttlMs : ttl,
        issuer : jwtConfig.issuer || SIS.JWT_DEFAULT_ISSUER,
        keysDir : path.resolve(confDir || DEFAULT_CONF_DIR, keysDir)
    };
}

class SessionManager {
    constructor(jwtConfig, opts) {
        opts = opts || { };
        var settings = resolveSettings(jwtConfig, opts.confDir);
        this.activeKid = settings.activeKid;
        this.ttlMs = settings.ttlMs;
        this.issuer = settings.issuer;
        this.keysDir = settings.keysDir;
        this.verifyKeys = { };
        this.signingKey = null;
        this._loadKeys(opts.requireSigningKey !== false, opts.logger);
    }

    _loadKeys(requireSigningKey, logger) {
        var hint = " Run `npm run gen-jwt-key` to create a key pair.";
        var files;
        try {
            files = fs.readdirSync(this.keysDir);
        } catch (ex) {
            throw configError("cannot read keys_dir " + this.keysDir + " (" + ex.code + ")." + hint);
        }

        files.forEach((file) => {
            var m = PUB_FILE_PATTERN.exec(file);
            if (!m) { return; }
            var full = path.join(this.keysDir, file);
            var key;
            try {
                key = crypto.createPublicKey(fs.readFileSync(full));
            } catch (ex) {
                throw configError("cannot load public key " + full + ": " + ex.message);
            }
            assertEd25519(key, full);
            this.verifyKeys[m[1]] = key;
        });

        var privFile = path.join(this.keysDir, keyFileName(this.activeKid, "key"));
        if (fs.existsSync(privFile)) {
            var priv;
            try {
                priv = crypto.createPrivateKey(fs.readFileSync(privFile));
            } catch (ex) {
                throw configError("cannot load private key " + privFile + ": " + ex.message);
            }
            assertEd25519(priv, privFile);
            var derived = crypto.createPublicKey(priv);
            var pub = this.verifyKeys[this.activeKid];
            if (pub && !sameKey(pub, derived)) {
                throw configError(privFile + " does not match " +
                                  keyFileName(this.activeKid, "pub"));
            }
            this.verifyKeys[this.activeKid] = derived;
            this.signingKey = priv;
            if (logger && process.platform !== "win32" &&
                (fs.statSync(privFile).mode & parseInt("077", 8))) {
                logger.warn({ file : privFile },
                            "JWT private key is readable by group or others; chmod 600 it");
            }
        } else if (requireSigningKey) {
            throw configError("missing private key " + privFile + "." + hint);
        }

        if (!Object.keys(this.verifyKeys).length) {
            throw configError("no public keys (jwt-<kid>.pub) found in " + this.keysDir + "." + hint);
        }
    }

    canIssue() {
        return !!this.signingKey;
    }

    // Resolves with { name : <jwt>, username, expires : Date }
    async issue(user) {
        if (!this.signingKey) {
            throw SIS.ERR_BAD_REQ("This server cannot issue session tokens.");
        }
        var username = user[SIS.FIELD_NAME];
        var nowMs = Date.now();
        var iat = Math.floor(nowMs / 1000);
        var exp = Math.floor((nowMs + this.ttlMs) / 1000);
        var jwt = await new jose.SignJWT({ sgen : user[SIS.FIELD_SESSION_GEN] || 0 })
            .setProtectedHeader({ alg : SIS.JWT_ALGORITHM, kid : this.activeKid, typ : "JWT" })
            .setIssuer(this.issuer)
            .setAudience(SIS.JWT_AUDIENCE)
            .setSubject(username)
            .setIssuedAt(iat)
            .setExpirationTime(exp)
            .setJti(crypto.randomBytes(16).toString("hex"))
            .sign(this.signingKey);
        var result = { };
        result[SIS.FIELD_NAME] = jwt;
        result[SIS.FIELD_USERNAME] = username;
        result[SIS.FIELD_EXPIRES] = new Date(exp * 1000);
        return result;
    }

    // Resolves with the verified claims, or rejects with a
    // SIS.ERR_BAD_CREDS error.
    async verify(token) {
        var getKey = (header) => {
            var key = header.kid && this.verifyKeys[header.kid];
            if (!key) {
                throw new Error("unknown kid");
            }
            return key;
        };
        var result;
        try {
            result = await jose.jwtVerify(token, getKey, {
                algorithms : [SIS.JWT_ALGORITHM],
                issuer : this.issuer,
                audience : SIS.JWT_AUDIENCE,
                typ : "JWT",
                requiredClaims : ["exp", "iat", "sub"],
                clockTolerance : SIS.JWT_CLOCK_TOLERANCE_SEC
            });
        } catch (err) {
            if (err && err.code === "ERR_JWT_EXPIRED") {
                throw SIS.ERR_BAD_CREDS("Token has expired.");
            }
            throw SIS.ERR_BAD_CREDS("Invalid token.");
        }
        var claims = result.payload;
        if (typeof claims.sub !== "string" || !claims.sub ||
            !Number.isInteger(claims.sgen)) {
            throw SIS.ERR_BAD_CREDS("Invalid token.");
        }
        return claims;
    }

    // true if the token has the shape of a JWT (vs. an opaque hex token)
    static isJwt(token) {
        return typeof token === "string" && JWT_PATTERN.test(token);
    }
}

export default function(jwtConfig, opts) {
    return new SessionManager(jwtConfig, opts);
}
export { SessionManager };
export const isJwt = SessionManager.isJwt;
export { keyFileName };
export { KID_PATTERN };
export { DEFAULT_CONF_DIR };
