import nconf from "nconf";
import should from "should";
import SIS from "../util/constants.js";
import * as TestUtil from "./fixtures/util.js";

describe('Readonly API ', function() {
    var schema = {
        "name":"test_entity",
        _sis : { "owner" : ["test"] },
        "definition": {
            "str":   "String",
            "num":   "Number",
            "date":  "Date",
            "bool":  "Boolean",
            "arr": []
        }
    };

    var ApiServer = new TestUtil.TestServer();
    var app = null;

    it("Should setup fixtures", async function() {
        nconf.add("readonly", {
                type: "literal",
                store: {
                    "app" : { "readonly" : true }
                }
            });
        var sd = await ApiServer.start();
        app = sd.app;
        var options = { user : sd.superUser, version : "v1.1" };
        try {
            await sd.schemaManager.delete(schema.name, options);
        } catch (err) {
            // not there yet
        }
        await sd.schemaManager.add(schema, options);
    });

    after(async function() {
        nconf.remove("readonly");
        await ApiServer.stop();
    });

    it("should have readonly set in the app", function() {
        should.exist(app.get("readonly"));
        app.get("readonly").should.eql(true);
    });

    var paths = [
        "/api/v1.1/schemas",
        "/api/v1.1/hiera",
        "/api/v1.1/entities/test_entity"
    ];

    paths.map(function(path) {
        it("should allow GET on " + path, async function() {
            await ApiServer.get(path).expect(200);
        });
    });

    paths.map(function(path) {
        it("should 404 when POSTing to " + path, async function() {
            await ApiServer.post(path)
                .send({"unprocessed" : "entity"})
                .expect(404);
        });
    });

});
