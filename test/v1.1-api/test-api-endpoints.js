describe("@API @V1.1API - Scripts API", function() {
    "use strict";
    let fs = require("fs");
    let path = require("path");
    let should = require("should");
    let TestUtil = require("../fixtures/util");
    let clone = require("clone");

    let ApiServer = new TestUtil.TestServer();

    function loadScript(scriptName) {
        scriptName += ".js";
        let p = path.join(__dirname, "..", "fixtures", "scripts", scriptName);
        return fs.readFileSync(p, { encoding: "utf8" });
    }

    after(function(done) {
        ApiServer.stop(done);
    });

    function errHandler(done) {
        return function(err, res) {
            if (err) {
                console.log(err);
                console.log(res.body);
            }
            should.not.exist(err);
            err = res.body;
            err.should.be.instanceof(Object);
            err.should.not.be.instanceof(Array);
            should.exist(err.code);
            should.exist(err.error);
            done();
        };
    }

    it("Should setup fixtures", function(done) {
        ApiServer.start(function(e) {
            if (e) {
                done(e);
                return;
            }
            ApiServer.becomeSuperUser(done);
        });
    });

    let script_type = "application/javascript";

    describe("Error cases", function() {
        it("Should fail if script doesn't exist", function(done) {
            ApiServer.get("/api/v1.1/scripts/foo").expect(404, errHandler(done));
        });
        it("Should fail to hit an endpoint that doesn't exist", function(done) {
            ApiServer.get("/api/v1.1/endpoints/foo").expect(404, errHandler(done));
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
            it("Should fail to add script without " + k, function(done) {
                delete o[k];
                ApiServer.post("/api/v1.1/scripts")
                    .send(o).expect(400, errHandler(done));
            });
        });
        // add a bad syntax one
        validObject.script = loadScript("bad_syntax");
        it("Should fail to add a script with bad syntax", function(done) {
            ApiServer.post("/api/v1.1/scripts")
                .send(validObject).expect(400, errHandler(done));

        });
    });

    function deleteScript(name, done) {
        let uri = "/api/v1.1/scripts/" + name;
        ApiServer.del(uri).end(done);
    }

    describe("Script params", function() {
        let name = "params";
        // nuke it if it exists
        before(function(done) {
            deleteScript(name, done);
        });
        it("should load the script", function(done) {
            let script = {
                name,
                script_type,
                script: loadScript("params"),
                _sis : {
                    owner : ["test"]
                }
            };
            ApiServer.post("/api/v1.1/scripts")
                .send(script).expect(201, done);
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
            it(`Should respond to ${uri} with ${expected}`, function(done) {
                ApiServer.get(uri).expect(200, function(err, res) {
                    should.not.exist(err);
                    res = res.body;
                    should.exist(res.path);
                    res.path.should.eql(expected);
                    done();
                });
            });
        });
    });

    describe("Output formats", function() {
        let csvParse = require("csv-parse/sync");
        let yaml = require("js-yaml");
        let name = 'formats';
        before(function(done) {
            deleteScript(name, done);
        });
        it("Should load the script", function(done) {
            let script = {
                name,
                script_type,
                script: loadScript(name),
                _sis : {
                    owner : ["test"]
                }
            };
            ApiServer.post("/api/v1.1/scripts")
                .send(script).expect(201, function(err, res) {
                    if (err) { console.log(err); console.log(res.body); }
                    done(err);
                });
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

        it("Should return csv", function(done) {
            let uri = `${baseUri}/csv`;
            ApiServer.get(uri).expect(200, function(err, res) {
                should.not.exist(err);
                let body = res.text;
                let result = csvParse.parse(body);
                result.should.eql(csvData);
                done();
            });
        });

        it("Should return yaml", function(done) {
            let uri = `${baseUri}/yaml`;
            ApiServer.get(uri).expect(200, function(err, res) {
                should.not.exist(err);
                let body = res.text;
                let data = yaml.load(body);
                data.should.eql(expectedData);
                done();
            });
        });

        it("Should return json", function(done) {
            let uri = `${baseUri}/json`;
            ApiServer.get(uri).expect(200, function(err, res) {
                should.not.exist(err);
                res.body.should.eql(expectedData);
                done();
            });
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
            await addScript("clienttest");
            await addScript("asyncrunner");
        });

        after(async function() {
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

    });
});
