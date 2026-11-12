// Optional TLS (HTTPS) for the API listener, configured by server.tls:
//   "tls" : {
//       "enabled" : true,
//       "cert" : "keys/tls.crt",   - PEM certificate (plus any intermediates)
//       "key" : "keys/tls.key",    - PEM private key
//       "passphrase" : "...",      - optional, for an encrypted key
//       "min_version" : "TLSv1.2"  - optional
//   }
// cert and key are resolved against the conf/ directory unless absolute.

'use strict';

var fs = require("fs");
var path = require("path");
var tls = require("tls");
var crypto = require("crypto");
var SIS = require("./constants");

var DEFAULT_CONF_DIR = path.join(__dirname, "..", "conf");

function configError(msg) {
    return new Error("Invalid server." + SIS.OPT_TLS + " configuration: " + msg);
}

function readFile(file, what) {
    try {
        return fs.readFileSync(file);
    } catch (ex) {
        throw configError("cannot read " + what + " " + file + " (" + ex.code + ")");
    }
}

function warnAboutFiles(certFile, keyFile, cert, logger) {
    if (process.platform !== "win32" &&
        (fs.statSync(keyFile).mode & parseInt("077", 8))) {
        logger.warn({ file : keyFile },
                    "TLS private key is readable by group or others; chmod 600 it");
    }
    var x509 = new crypto.X509Certificate(cert);
    var now = Date.now();
    if (now > Date.parse(x509.validTo)) {
        logger.warn({ file : certFile, valid_to : x509.validTo }, "TLS certificate has expired");
    } else if (now < Date.parse(x509.validFrom)) {
        logger.warn({ file : certFile, valid_from : x509.validFrom }, "TLS certificate is not yet valid");
    }
}

// Returns the options for https.createServer / server.setSecureContext, or
// null when TLS is disabled.  Throws if TLS is enabled and the cert or key is
// missing, unreadable, or invalid.
function loadTlsOptions(tlsConfig, opts) {
    tlsConfig = tlsConfig || { };
    opts = opts || { };
    if (!tlsConfig.enabled) {
        return null;
    }
    var confDir = opts.confDir || DEFAULT_CONF_DIR;
    var certFile = path.resolve(confDir, tlsConfig.cert || SIS.TLS_DEFAULT_CERT);
    var keyFile = path.resolve(confDir, tlsConfig.key || SIS.TLS_DEFAULT_KEY);
    var options = {
        cert : readFile(certFile, "cert"),
        key : readFile(keyFile, "key"),
        minVersion : tlsConfig.min_version || SIS.TLS_DEFAULT_MIN_VERSION
    };
    if (tlsConfig.passphrase) {
        options.passphrase = String(tlsConfig.passphrase);
    }
    // let node validate the PEMs, key/cert match, passphrase and min_version
    try {
        tls.createSecureContext(options);
    } catch (ex) {
        throw configError(certFile + " / " + keyFile + ": " + ex.message);
    }
    if (opts.logger) {
        warnAboutFiles(certFile, keyFile, options.cert, opts.logger);
    }
    return options;
}

module.exports.loadTlsOptions = loadTlsOptions;
module.exports.DEFAULT_CONF_DIR = DEFAULT_CONF_DIR;
