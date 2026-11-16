import fs from "fs";
import path from "path";
import should from "should";
import clone from "clone";
import * as csvParse from "csv-parse/sync";
import yaml from "js-yaml";
import ChildProcess from "child_process";
import * as TestUtil from "../fixtures/util.js";

describe("@API @V1.1API - Scripts API", function() {
    let ApiServer = new TestUtil.TestServer();

    function loadScript(scriptName) {
        scriptName += ".js";
        let p = path.join(import.meta.dirname, "..", "fixtures", "scripts", scriptName);
        return fs.readFileSync(p, { encoding: "utf8" });
    }

    after(async function() {
        await ApiServer.stop();
    });

    // the body of an error response is a SIS error object
    function expectErrorBody(res) {
        let err = res.body;
        err.should.be.instanceof(Object);
        err.should.not.be.instanceof(Array);
        should.exist(err.code);
        should.exist(err.error);
    }

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    let script_type = "application/javascript";

    describe("Error cases", function() {
        it("Should fail if script doesn't exist", async function() {
            expectErrorBody(await ApiServer.get("/api/v1.1/scripts/foo").expect(404));
        });
        it("Should fail to hit an endpoint that doesn't exist", async function() {
            expectErrorBody(await ApiServer.get("/api/v1.1/endpoints/foo").expect(404));
        });
        let validObject = {
            name: "valid",
            script_type,
            script: loadScript("timeout"),
            _sis : {
                owner : ["test"]
            }
        };
        Object.keys(validObject).forEach(function(k) {
            let o = clone(validObject);
            it("Should fail to add script without " + k, async function() {
                delete o[k];
                expectErrorBody(await ApiServer.post("/api/v1.1/scripts")
                    .send(o).expect(400));
            });
        });
        // add a bad syntax one
        validObject.script = loadScript("bad_syntax");
        it("Should fail to add a script with bad syntax", async function() {
            expectErrorBody(await ApiServer.post("/api/v1.1/scripts")
                .send(validObject).expect(400));
        });
    });

    function deleteScript(name) {
        return ApiServer.del("/api/v1.1/scripts/" + name);
    }

    describe("Script params", function() {
        let name = "params";
        // nuke it if it exists
        before(async function() {
            await deleteScript(name);
        });
        it("should load the script", async function() {
            let script = {
                name,
                script_type,
                script: loadScript("params"),
                _sis : {
                    owner : ["test"]
                }
            };
            await ApiServer.post("/api/v1.1/scripts")
                .send(script).expect(201);
        });

        let allPaths = [
            ["", "/"],
            ["/", "/"],
            ["/p1", "/p1"],
            ["/p1/", "/p1/"],
            ["/p1/p2", "/p1/p2"],
            ["/p1/p2/", "/p1/p2/"],
        ];
        allPaths.forEach(function(p) {
            let path = p[0];
            let expected = p[1];
            let uri = "/api/v1.1/endpoints/params" + path;
            it(`Should respond to ${uri} with ${expected}`, async function() {
                let res = (await ApiServer.get(uri).expect(200)).body;
                should.exist(res.path);
                res.path.should.eql(expected);
            });
        });
    });

    describe("Output formats", function() {
        let name = 'formats';
        before(async function() {
            await deleteScript(name);
        });
        it("Should load the script", async function() {
            let script = {
                name,
                script_type,
                script: loadScript(name),
                _sis : {
                    owner : ["test"]
                }
            };
            await ApiServer.post("/api/v1.1/scripts")
                .send(script).expect(201);
        });

        let expectedData  = [
            {"name":"hello", "value":"world" },
            {"name":"foo", "value":"bar" }
        ];
        let csvData = [
            ['hello','world'],
            ['foo','bar']
        ];

        let baseUri = "/api/v1.1/endpoints/formats";

        it("Should return csv", async function() {
            let res = await ApiServer.get(`${baseUri}/csv`).expect(200);
            csvParse.parse(res.text).should.eql(csvData);
        });

        it("Should return yaml", async function() {
            let res = await ApiServer.get(`${baseUri}/yaml`).expect(200);
            yaml.load(res.text).should.eql(expectedData);
        });

        it("Should return json", async function() {
            let res = await ApiServer.get(`${baseUri}/json`).expect(200);
            res.body.should.eql(expectedData);
        });
    });

    describe("Client", function() {
        let schema = {
            name : "test_ep_client_hosts",
            id_field : "name",
            _sis : { owner : ["test"] },
            definition : { name : { type : "String", required : true, unique : true }, env : "String" }
        };
        let baseUri = "/api/v1.1/endpoints/clienttest";

        async function addScript(name) {
            await ApiServer.del("/api/v1.1/scripts/" + name);
            await ApiServer.post("/api/v1.1/scripts").send({
                name, script_type, script : loadScript(name), _sis : { owner : ["test"] }
            }).expect(201);
        }

        before(async function() {
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            await ApiServer.post("/api/v1.1/entities/" + schema.name)
                .send([{ name : "h1", env : "qa" }, { name : "h2", env : "prod" }, { name : "h3", env : "qa" }])
                .expect(200);
            await ApiServer.del("/api/v1.1/hiera/test_ep_client_hiera");
            await ApiServer.post("/api/v1.1/hiera")
                .send({ name : "test_ep_client_hiera", _sis : { owner : ["test"] }, hieradata : { port : 80 } })
                .expect(201);
            await addScript("clienttest");
            await addScript("asyncrunner");
        });

        after(async function() {
            await ApiServer.del("/api/v1.1/hiera/test_ep_client_hiera");
            await ApiServer.del("/api/v1.1/scripts/clienttest");
            await ApiServer.del("/api/v1.1/scripts/asyncrunner");
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
        });

        // scripts answer well within this - a hung worker does not
        function get(path) {
            return ApiServer.get(baseUri + path).timeout(4000);
        }

        it("Should get an entity", async function() {
            let res = await get("/get?name=h1").expect(200);
            res.body.name.should.eql("h1");
            res.body.env.should.eql("qa");
        });

        it("Should list entities matching a query", async function() {
            let res = await get("/list?env=qa").expect(200);
            res.body.map(function(h) { return h.name; }).should.eql(["h1", "h3"]);
        });

        it("Should reject an invalid query", async function() {
            let res = await get("/badquery").expect(400);
            res.body.error.should.match(/Query parameter is invalid/);
        });

        it("Should get schemas", async function() {
            let res = await get("/schema").expect(200);
            res.body.get.name.should.eql(schema.name);
            res.body.get.definition.should.eql(schema.definition);
            res.body.list.map(function(s) { return s.name; }).should.eql([schema.name]);
        });

        it("Should get hiera entries as the hiera API sends them", async function() {
            let res = await get("/hiera").expect(200);
            // the hiera API sends a single entry as { name : hieradata }
            res.body.get.should.eql({ test_ep_client_hiera : { port : 80 } });
            res.body.list.length.should.eql(1);
            res.body.list[0].hieradata.should.eql({ port : 80 });
        });

        it("Should pass errors to the script", async function() {
            let res = await get("/get?name=nope").expect(404);
            res.body.error.should.match(/does not exist/);
            res = await get("/missing").expect(404);
            res.body.error.should.match(/test_ep_no_such_schema does not exist/);
        });

        it("Should run generators with the async helper", async function() {
            let res = await ApiServer.get("/api/v1.1/endpoints/asyncrunner").timeout(4000).expect(200);
            res.body.should.eql({ host : "h1", missing : 404 });
        });

        it("Should keep working after a client for a missing schema goes unused", async function() {
            (await get("/unused").expect(200)).text.should.eql("unused");
            (await get("/").expect(200)).text.should.eql("ok");
        });

        it("Should keep working after a script leaves a rejection unhandled", async function() {
            (await get("/reject").expect(200)).text.should.eql("rejected");
            (await get("/").expect(200)).text.should.eql("ok");
        });

        it("Should keep working after a script process dies", async function() {
            if (process.env.SIS_REMOTE_URL) {
                // the script processes are not ours to kill
                return this.skip();
            }
            (await get("/").expect(200)).text.should.eql("ok");
            // run pgrep itself, not through a shell: the shell would be one of
            // our children with endpoints/main.js in its command line
            let found = "";
            try {
                found = ChildProcess.execFileSync("pgrep", ["-P", String(process.pid), "-f", "endpoints/main.js"]);
            } catch (err) {
                // pgrep exits with 1 when nothing matches
            }
            let pids = String(found).split("\n").filter(Boolean);
            pids.length.should.be.above(0);
            pids.forEach(function(pid) { process.kill(Number(pid), "SIGKILL"); });
            await new Promise(function(resolve) { setTimeout(resolve, 200); });
            (await get("/").expect(200)).text.should.eql("ok");
            (await get("/").expect(200)).text.should.eql("ok");
        });

        it("Should send script errors without the server's internals", async function() {
            let res = await get("/throw").expect(500);
            res.body.error.should.match(/TypeError: Cannot read properties of null/);
            // where in the script it failed, but nothing about the server
            res.body.error.should.match(/clienttest:\d+/);
            res.body.error.should.not.match(/endpoints\/runner\.js|node:internal|\/node_modules\//);
            (await get("/").expect(200)).text.should.eql("ok");
        });
    });
});
