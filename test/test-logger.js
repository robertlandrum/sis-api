import should from "should";
import nconf from "nconf";
import * as logger from "../util/logger.js";

describe("Logger", function() {
    // the records a logger writes while fn runs, parsed
    function captureRecords(fn) {
        var lines = [];
        var write = process.stdout.write;
        process.stdout.write = function(chunk) {
            lines.push(String(chunk));
            return true;
        };
        try {
            fn();
        } finally {
            process.stdout.write = write;
        }
        return lines.join("").split("\n").filter(Boolean).map(function(l) { return JSON.parse(l); });
    }

    // the test config sets logger options of its own - log at info here
    var configured = null;
    beforeEach(function() {
        configured = nconf.get("logger:options");
        setLoggerOptions({ level : "info" });
    });

    afterEach(function() {
        nconf.set("logger:options", configured);
    });

    function setLoggerOptions(options) {
        nconf.set("logger:options", options);
    }

    it("uses the logger options configured after it was created", function() {
        // modules create their loggers when they load, before the
        // configuration is read
        var log = logger.createLogger({ name : "LateConfig" });
        setLoggerOptions({ level : "warn" });
        // what it logs at info, and its name, show the options it was made with
        var records = captureRecords(function() {
            log.info("not at info");
            log.warn("at warn");
        });
        records.map(function(r) { return r.msg; }).should.eql(["at warn"]);
        records[0].name.should.eql("LateConfig");
    });

    it("makes children with the parent's fields", function() {
        var log = logger.createLogger({ name : "Parent" });
        var records = captureRecords(function() {
            log.child({ req_id : "r1" }).info("from the child");
        });
        records.length.should.eql(1);
        records[0].name.should.eql("Parent");
        records[0].req_id.should.eql("r1");
    });

    it("serializes errors", function() {
        var log = logger.createLogger({ name : "Errors" });
        var records = captureRecords(function() {
            log.error({ err : new Error("boom") }, "failed");
        });
        records[0].err.message.should.eql("boom");
        should.exist(records[0].err.stack);
    });
});
