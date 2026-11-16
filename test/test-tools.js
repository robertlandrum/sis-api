import should from "should";
import fs from "fs";
import os from "os";
import path from "path";
import ChildProcess from "child_process";

describe("Tools", function() {
    var root = path.join(import.meta.dirname, "..");
    var samples = path.join(root, "samples");

    this.timeout(30000);

    // run a tool like a user would.  Resolves with its exit code and output.
    function run(tool, args) {
        return new Promise(function(resolve) {
            ChildProcess.execFile(process.execPath, [path.join("tools", tool)].concat(args), { cwd : root },
                function(err, stdout, stderr) {
                    resolve({ code : err ? err.code : 0, output : stdout + stderr });
                });
        });
    }

    function tmpJson(name, obj) {
        var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sis-tools-")), name);
        fs.writeFileSync(file, JSON.stringify(obj));
        return file;
    }

    describe("validate", function() {
        var schemaFile = path.join(samples, "schema_sample.json");

        it("accepts the sample schema", async function() {
            var result = await run("validate.js", [schemaFile]);
            result.output.trim().should.eql("Schema is valid.");
            result.code.should.eql(0);
        });

        it("accepts the sample entity", async function() {
            var result = await run("validate.js", [schemaFile, path.join(samples, "entity_sample.json")]);
            result.output.trim().should.eql("Entity is valid.");
            result.code.should.eql(0);
        });

        it("rejects an entity the schema does not allow", async function() {
            var entity = JSON.parse(fs.readFileSync(path.join(samples, "entity_sample.json"), "utf8"));
            entity.numberField = "not a number";
            delete entity.requiredField;
            var result = await run("validate.js", [schemaFile, tmpJson("entity.json", entity)]);
            result.output.should.match(/^Entity is invalid\. .*numberField/);
            result.output.should.match(/requiredField/);
            result.output.should.not.match(/\n\s+at /);
            result.code.should.eql(1);
        });

        it("rejects an invalid schema", async function() {
            var result = await run("validate.js", [tmpJson("schema.json", { name : "x", _sis : { owner : ["o"] } })]);
            result.output.trim().should.eql("Schema is invalid.  Schema definition must be an object.");
            result.code.should.eql(1);
        });
    });
});
