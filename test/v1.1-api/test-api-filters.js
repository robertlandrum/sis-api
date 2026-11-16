import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Filtering API', function() {
    var ApiServer = new TestUtil.TestServer();

    var schema = {
        "name":"test_api_filters",
        _sis : { "owner" : ["test_g1"] },
        "definition": {
            "str" : "String",
            "num": "Number",
            "b" : "Boolean"
        }
    };

    var NUM_ITEMS = 15;

    var createItems = function(start, num) {
        var result = [];
        for (var i = start; i < (start + num); ++i) {
            result.push({ num: i, str : "foo_" + i, b : i % 3 > 0 });
        }
        return result;
    };

    after(async function() {
        await ApiServer.stop();
    });

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
        await ApiServer.del('/api/v1.1/schemas/' + schema.name);
        await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(0, NUM_ITEMS))
            .expect(200);
        res.body.success.length.should.eql(NUM_ITEMS);
        res.body.success.forEach(function(i) {
            should.exist(i._id);
        });
    });

    var runQuery = async function(queryObj, numExpected) {
        var res = await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .query({ q : JSON.stringify(queryObj) }).expect(200);
        res.body.length.should.eql(numExpected);
    };

    it("Should fetch all objects with $gte", async function() {
        await runQuery({ num : { $gte : 0 }}, NUM_ITEMS);
    });

    it("Should fetch all objects where b is false", async function() {
        await runQuery({ b : false }, NUM_ITEMS / 3);
    });

    it("Should fetch all objects with $exists", async function() {
        await runQuery({ 'str' : { '$exists' : true }}, NUM_ITEMS);
    });


});
