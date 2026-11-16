import should from "should";
import net from "net";
import path from "path";
import ChildProcess from "child_process";
import nconf from "nconf";

describe('Server start', function() {
    this.timeout(30000);

    // run server.js like a user would, until it exits.  Resolves with its
    // exit code and output.
    function runServer(env) {
        var root = path.join(import.meta.dirname, "..");
        return new Promise(function(resolve) {
            var child = ChildProcess.spawn(process.execPath, ["server.js"], {
                cwd : root,
                env : Object.assign({ }, process.env, {
                    db__url : nconf.get("db:url"),
                    app__jwt__keys_dir : path.join(import.meta.dirname, "fixtures", "keys"),
                    app__use_cluster : "false",
                    app__auth : "false"
                }, env)
            });
            var output = "";
            child.stdout.on("data", function(d) { output += d; });
            child.stderr.on("data", function(d) { output += d; });
            var timer = setTimeout(function() {
                child.kill("SIGKILL");
            }, 20000);
            child.on("exit", function(code, signal) {
                clearTimeout(timer);
                resolve({ code : code, signal : signal, output : output });
            });
        });
    }

    it("exits with an error when its port is taken", async function() {
        var holder = net.createServer();
        await new Promise(function(resolve) { holder.listen(0, resolve); });
        try {
            var result = await runServer({ server__port : String(holder.address().port) });
            should(result.signal).be.null();
            result.code.should.eql(1);
            result.output.should.match(/Error starting the server/);
            result.output.should.match(/EADDRINUSE/);
        } finally {
            holder.close();
        }
    });

    it("stops instead of forking workers again when they cannot start", async function() {
        var holder = net.createServer();
        await new Promise(function(resolve) { holder.listen(0, resolve); });
        try {
            var result = await runServer({ server__port : String(holder.address().port),
                                           app__use_cluster : "true" });
            should(result.signal).be.null();
            result.code.should.eql(1);
            result.output.should.match(/A worker failed to start/);
            result.output.should.not.match(/forking again/);
        } finally {
            holder.close();
        }
    });
});
