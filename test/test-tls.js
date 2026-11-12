describe('TLS', function() {
    "use strict";

    var should = require('should');
    var fs = require('fs');
    var os = require('os');
    var path = require('path');
    var https = require('https');
    var childProcess = require('child_process');
    var nconf = require('nconf');

    var loadTlsOptions = require("../util/tls-config").loadTlsOptions;

    var ROOT = path.join(__dirname, "..");
    var KEYS = path.join(__dirname, "fixtures", "keys");
    var tmpDirs = [];

    after(function() {
        tmpDirs.forEach(function(dir) {
            fs.rmSync(dir, { recursive : true, force : true });
        });
    });

    function tmpDir() {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), "sis-tls-"));
        tmpDirs.push(dir);
        return dir;
    }

    // a conf dir holding keys/tls.{crt,key}, copied from the named fixture pair
    function confDirWith(pair) {
        var dir = tmpDir();
        fs.mkdirSync(path.join(dir, "keys"));
        copyPair(dir, pair);
        return dir;
    }

    function copyPair(confDir, pair) {
        ["crt", "key"].forEach(function(ext) {
            var dest = path.join(confDir, "keys", "tls." + ext);
            fs.copyFileSync(path.join(KEYS, pair + "." + ext), dest);
            fs.chmodSync(dest, parseInt("600", 8));
        });
    }

    function fixture(file) {
        return fs.readFileSync(path.join(KEYS, file));
    }

    function captureLogger() {
        var warnings = [];
        return {
            warnings : warnings,
            warn : function(obj, msg) { warnings.push(msg); }
        };
    }

    describe("loadTlsOptions", function() {
        it("returns null when disabled", function() {
            should(loadTlsOptions(undefined)).be.null();
            should(loadTlsOptions({ })).be.null();
            should(loadTlsOptions({ enabled : false, cert : "/nope" })).be.null();
        });

        it("loads keys/tls.crt and keys/tls.key next to the config by default", function() {
            var dir = confDirWith("tls");
            var logger = captureLogger();
            var opts = loadTlsOptions({ enabled : true }, { confDir : dir, logger : logger });
            opts.cert.equals(fixture("tls.crt")).should.be.true();
            opts.key.equals(fixture("tls.key")).should.be.true();
            opts.minVersion.should.eql("TLSv1.2");
            should(opts.passphrase).be.undefined();
            logger.warnings.should.eql([]);
        });

        it("resolves relative paths against the conf dir and keeps absolute ones", function() {
            var dir = confDirWith("tls");
            var opts = loadTlsOptions({
                enabled : true,
                cert : path.join(KEYS, "tls-alt.crt"),
                key : path.join(KEYS, "tls-alt.key"),
                min_version : "TLSv1.3"
            }, { confDir : dir });
            opts.cert.equals(fixture("tls-alt.crt")).should.be.true();
            opts.minVersion.should.eql("TLSv1.3");

            fs.renameSync(path.join(dir, "keys"), path.join(dir, "certs"));
            opts = loadTlsOptions({ enabled : true, cert : "certs/tls.crt", key : "certs/tls.key" },
                                  { confDir : dir });
            opts.cert.equals(fixture("tls.crt")).should.be.true();
        });

        it("rejects missing files", function() {
            var dir = tmpDir();
            (function() {
                loadTlsOptions({ enabled : true }, { confDir : dir });
            }).should.throw(/server\.tls.*cannot read cert .*keys\/tls\.crt \(ENOENT\)/);
            fs.mkdirSync(path.join(dir, "keys"));
            fs.copyFileSync(path.join(KEYS, "tls.crt"), path.join(dir, "keys", "tls.crt"));
            (function() {
                loadTlsOptions({ enabled : true }, { confDir : dir });
            }).should.throw(/cannot read key .*keys\/tls\.key \(ENOENT\)/);
        });

        it("rejects a key that does not match the cert", function() {
            var dir = confDirWith("tls");
            fs.copyFileSync(path.join(KEYS, "tls-alt.key"), path.join(dir, "keys", "tls.key"));
            (function() {
                loadTlsOptions({ enabled : true }, { confDir : dir });
            }).should.throw(/server\.tls.*key values mismatch/);
        });

        it("rejects a file that is not PEM", function() {
            var dir = confDirWith("tls");
            fs.writeFileSync(path.join(dir, "keys", "tls.crt"), "not a cert");
            (function() {
                loadTlsOptions({ enabled : true }, { confDir : dir });
            }).should.throw(/server\.tls/);
        });

        it("rejects an unknown min_version", function() {
            var dir = confDirWith("tls");
            (function() {
                loadTlsOptions({ enabled : true, min_version : "SSLv3" }, { confDir : dir });
            }).should.throw(/server\.tls/);
        });

        it("warns when the private key is readable by others", function() {
            if (process.platform === "win32") { return this.skip(); }
            var dir = confDirWith("tls");
            fs.chmodSync(path.join(dir, "keys", "tls.key"), parseInt("644", 8));
            var logger = captureLogger();
            loadTlsOptions({ enabled : true }, { confDir : dir, logger : logger });
            logger.warnings.should.eql(["TLS private key is readable by group or others; chmod 600 it"]);
        });
    });

    // Runs the real server.js entry point, the way an operator would.
    describe("server.js over HTTPS", function() {
        var PORT = 3011;
        var child = null;
        var output = "";
        var tlsDir = null;

        function spawnServer(env) {
            output = "";
            var proc = childProcess.spawn(process.execPath, [path.join(ROOT, "server.js")], {
                cwd : ROOT,
                env : Object.assign({ }, process.env, {
                    db__url : nconf.get("db:url") || "mongodb://localhost/sis-test",
                    server__port : String(PORT),
                    server__address : "127.0.0.1",
                    app__use_cluster : "false",
                    app__jwt__keys_dir : KEYS,
                    logger__options__level : "info"
                }, env),
                stdio : ["ignore", "pipe", "pipe"]
            });
            proc.stdout.on("data", function(d) { output += d; });
            proc.stderr.on("data", function(d) { output += d; });
            return proc;
        }

        function stopServer(done) {
            if (!child || child.exitCode !== null) { child = null; return done(); }
            child.once("exit", function() { child = null; done(); });
            child.kill("SIGINT");
        }

        // HEAD / over https, trusting only the given fixture cert
        function head(caFile, callback) {
            var req = https.request({
                host : "127.0.0.1",
                port : PORT,
                method : "HEAD",
                path : "/",
                ca : fixture(caFile),
                agent : false
            }, function(res) {
                var fp = res.socket.getPeerCertificate().fingerprint256;
                res.resume();
                callback(null, res.statusCode, fp);
            });
            req.on("error", callback);
            req.end();
        }

        function waitForOutput(pattern, callback) {
            var deadline = Date.now() + 30000;
            (function poll() {
                if (pattern.test(output)) { return callback(); }
                if (child.exitCode !== null || Date.now() > deadline) {
                    return callback(new Error("server did not log " + pattern + ":\n" + output));
                }
                setTimeout(poll, 100);
            })();
        }

        function fingerprint(file) {
            return new (require("crypto").X509Certificate)(fixture(file)).fingerprint256;
        }

        before(function(done) {
            tlsDir = confDirWith("tls");
            child = spawnServer({
                server__tls__enabled : "true",
                server__tls__cert : path.join(tlsDir, "keys", "tls.crt"),
                server__tls__key : path.join(tlsDir, "keys", "tls.key")
            });
            waitForOutput(/"msg":"Listening"/, done);
        });

        after(stopServer);

        it("serves the API over HTTPS with the configured cert", function(done) {
            output.should.match(/"tls":true/);
            head("tls.crt", function(err, status, fp) {
                if (err) { return done(err); }
                status.should.eql(200);
                fp.should.eql(fingerprint("tls.crt"));
                done();
            });
        });

        it("does not answer plain HTTP", function(done) {
            require("http").get({ host : "127.0.0.1", port : PORT, path : "/api/v1.1/info" }, function(res) {
                res.resume();
                done(new Error("plain HTTP got a " + res.statusCode + " response"));
            }).on("error", function(err) {
                err.code.should.eql("ECONNRESET");
                done();
            });
        });

        it("passes the container healthcheck", function() {
            childProcess.execFileSync(process.execPath, [path.join(ROOT, "scripts", "healthcheck.js")], {
                env : Object.assign({ }, process.env, {
                    server__port : String(PORT),
                    server__tls__enabled : "true"
                })
            });
        });

        it("keeps the current cert when SIGHUP finds a bad one", function(done) {
            fs.writeFileSync(path.join(tlsDir, "keys", "tls.crt"), "garbage");
            child.kill("SIGHUP");
            waitForOutput(/TLS reload failed/, function(err) {
                if (err) { return done(err); }
                head("tls.crt", function(err, status, fp) {
                    if (err) { return done(err); }
                    fp.should.eql(fingerprint("tls.crt"));
                    done();
                });
            });
        });

        it("reloads the cert on SIGHUP", function(done) {
            copyPair(tlsDir, "tls-alt");
            child.kill("SIGHUP");
            waitForOutput(/Reloaded TLS certificate/, function(err) {
                if (err) { return done(err); }
                head("tls-alt.crt", function(err, status, fp) {
                    if (err) { return done(err); }
                    status.should.eql(200);
                    fp.should.eql(fingerprint("tls-alt.crt"));
                    done();
                });
            });
        });

        it("refuses to start when the cert is missing", function(done) {
            stopServer(function() {
                child = spawnServer({
                    server__tls__enabled : "true",
                    server__tls__cert : path.join(tmpDir(), "missing.crt")
                });
                child.once("exit", function(code) {
                    code.should.eql(1);
                    output.should.match(/Invalid server\.tls configuration: cannot read cert .*missing\.crt \(ENOENT\)/);
                    done();
                });
            });
        });
    });
});
