import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Schema API', function() {
    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    // the body of an error response is a SIS error object
    function expectErrorBody(res) {
        var err = res.body;
        err.should.be.instanceof(Object);
        err.should.not.be.instanceof(Array);
        should.exist(err.code);
        should.exist(err.error);
    }

    describe("Schema failure cases", function() {
        it("Should fail if type does not exist ", async function() {
            expectErrorBody(await ApiServer.get("/api/v1.1/schemas/dne").expect(404));
        });
        it("Should fail to delete type if it doesn't exist", async function() {
            expectErrorBody(await ApiServer.del("/api/v1.1/schemas/dne").expect(404));
        });
        it("Should fail to add an invalid schema", async function() {
            expectErrorBody(await ApiServer.post("/api/v1.1/schemas")
                .set("Content-type", "application/json")
                .send({"name" : "no_owner_or_def"})
                .expect(400));
        });
        it("Should fail to update a schema that DNE", async function() {
            expectErrorBody(await ApiServer.put("/api/v1.1/schemas/DNE")
                .set("Content-type", "application/json")
                .send({"name" : "DNE", _sis : { "owner" : "DNE" }, "definition" : {"k" : "String"}})
                .expect(404));
        });
        it("Should fail to add a schema with a bad name", async function() {
            var schema = {
                "name" : "@#(*^! !(@#*$!",
                _sis : { "owner" : "test" },
                "definition" : {
                    "name" : "String"
                }
            };
            expectErrorBody(await ApiServer.post("/api/v1.1/schemas")
                .set("Content-type", "application/json")
                .send(schema)
                .expect(400));
        });
        it("Should fail to add a schema with a non existent ID field", async function() {
            var schema = {
                name : "test_bad_id_1",
                id_field : "bogus",
                _sis : { owner : ["sistest"] },
                definition : {
                    name : "String"
                }
            };
            expectErrorBody(await ApiServer.post("/api/v1.1/schemas")
                .set("Content-type", "application/json")
                .send(schema)
                .expect(400));
        });
        it("Should fail to add a schema with a non unique / required id field", async function() {
            var schema = {
                name : "test_bad_id_2",
                id_field : "name",
                _sis : { owner : ["sistest"] },
                definition : {
                    name : "String"
                }
            };
            expectErrorBody(await ApiServer.post("/api/v1.1/schemas")
                .set("Content-type", "application/json")
                .send(schema)
                .expect(400));
        });
        it("Should fail to add a schema whose definition is not an object", async function() {
            for (var definition of ["name", 5, ["name", "String"], null]) {
                var res = await ApiServer.post("/api/v1.1/schemas")
                    .send({ name : "test_bad_definition", _sis : { owner : ["sistest"] }, definition : definition })
                    .expect(400);
                res.body.error.should.eql("Bad request: Schema definition must be an object.");
            }
            res = await ApiServer.post("/api/v1.1/schemas")
                .send({ name : "test_bad_definition", _sis : { owner : ["sistest"] } })
                .expect(400);
            res.body.error.should.eql("Bad request: Schema definition must be an object.");
        });
        it("Should fail to add a schema with invalid JSON", async function() {
            expectErrorBody(await ApiServer.post("/api/v1.1/schemas")
                .set("Content-type", "application/json")
                .send("{ Invalid JSON }")
                .expect(400));
        });
    });
    describe("Allowed schemas in v1.1", function() {
        // no longer an issue in v1.1
        it("Should not fail to add a schema with a sis_ field", async function() {
            var schema = {
                name : "test_schema_field_sis",
                _sis : { owner : ["sistest"] },
                definition : {
                    sis_name : "String"
                }
            };
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
            await ApiServer.post("/api/v1.1/schemas")
                .send(schema)
                .expect(201);
        });
        var types = ["Number", "String", "ObjectId", { }, "Boolean"];
        types.forEach(function(type, idx) {
            it("Should add a schema with owner = " + JSON.stringify(type), async function() {
                var schema = {
                    name : "test_schema_owner_field_" + idx,
                    _sis : { owner : ["sistest"] },
                    definition : {
                        owner : type
                    }
                };
                await ApiServer.del("/api/v1.1/schemas/" + schema.name);
                await ApiServer.post("/api/v1.1/schemas")
                    .set("Content-type", "application/json")
                    .send(schema)
                    .expect(201);
            });
        });
        var badQueries = [
            "fooo",
            "null",
            "foo:bar",
            '["valid","array"]'
        ];

        badQueries.forEach(function(bq) {
            it("Should return a 400 with query " + bq, async function() {
                await ApiServer.get("/api/v1.1/schemas")
                    .query({ q: bq })
                    .expect(400);
            });
        });
    });

    describe("CRUD schema", function() {
        var jsData = {
            "name":"test_network_element",
            _sis : { owner : ["sistest"] },
            "definition": {
                "ne_type": "String",
                "cid":     "String",
                "ip":      "String",
                "ip6":     "String",
                "bgpip":   "String",
                "bgpip6":  "String",
                "owner" : ["String"]
            }
        };
        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/test_network_element');
        });

        // the fields of the schema sent, as the response has them
        function expectSchemaFields(data) {
            should.exist(data);
            for (var k in jsData) {
                if (k === '_sis') { continue; }
                jsData[k].should.eql(data[k]);
            }
        }

        it("Should create new schemas", async function() {
            await ApiServer.post("/api/v1.1/schemas")
                .set('Content-Type', 'application/json')
                .send(jsData)
                .expect(201);
        });
        it("Should get the schema", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas/test_network_element")
                .expect(200);
            expectSchemaFields(res.body);
        });
        it("Should update the schema", async function() {
            // update jsdata
            jsData.definition.cid = "Number";
            var res = await ApiServer.put("/api/v1.1/schemas/test_network_element")
                .set("Content-type", "application/json")
                .send(jsData)
                .expect(200);
            expectSchemaFields(res.body);
        });
        it("Should fail to change the schema name", async function() {
            var renamed = Object.assign({ }, jsData, { name : "whatever" });
            await ApiServer.put("/api/v1.1/schemas/test_network_element")
                .set("Content-type", "application/json")
                .send(renamed)
                .expect(400);
        });
        it("Should fail to update the schema with an invalid body", async function() {
            var invalid = Object.assign({ }, jsData, { definition : { cid : "NoSuchType" } });
            var res = await ApiServer.put("/api/v1.1/schemas/test_network_element")
                .set("Content-type", "application/json")
                .send(invalid)
                .expect(400);
            res.body.error.should.match(/NoSuchType/);
        });
        it("Should delete the schema", async function() {
            await ApiServer.del("/api/v1.1/schemas/test_network_element")
                .expect(200);
        });
    });

    describe("Schema search", function() {
        before(async function() {
            // insert three schemas
            var schemas = [{ "name":"s1", "definition": { "field" : "String" }, _sis : { "owner" : "sistest_rops" } },
                           { "name":"s2", "definition": { "field" : "String" }, _sis : { "owner" : "sistest_rops" } },
                           { "name":"t1", "definition": { "field" : "String" }, _sis : { "owner" : "sistest_pops" } }];
            await Promise.all(schemas.map(function(schema) {
                return ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
            }));
        });
        after(async function() {
            await Promise.all(['s1', 's2', 't1'].map(function(schema) {
                return ApiServer.del('/api/v1.1/schemas/' + schema).expect(200);
            }));
        });
        it("Should return 2 results", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas")
                .query({ offset : 1, limit : 2})
                .expect(200);
            res.body.length.should.eql(2);
        });
        it("sends the count of all the matches with a page of them", async function() {
            var q = { q : JSON.stringify({ "_sis.owner" : ["sistest_rops"] }) };
            var res = await ApiServer.get("/api/v1.1/schemas").query(Object.assign({ limit : 1 }, q)).expect(200);
            res.body.length.should.eql(1);
            res.headers["x-total-count"].should.eql("2");
            res = await ApiServer.get("/api/v1.1/schemas").query(Object.assign({ offset : 1 }, q)).expect(200);
            res.body.length.should.eql(1);
            res.headers["x-total-count"].should.eql("2");
        });
        it("sends no matches for an offset at or past the count", async function() {
            var q = { q : JSON.stringify({ "_sis.owner" : ["sistest_rops"] }) };
            for (var offset of [2, 3]) {
                var res = await ApiServer.get("/api/v1.1/schemas").query(Object.assign({ offset : offset }, q))
                    .expect(200);
                res.body.should.eql([]);
                res.headers["x-total-count"].should.eql("2");
            }
        });
        it("sends a count of 0 when nothing matches", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas").query({ q : JSON.stringify({ name : "nope" }) })
                .expect(200);
            res.body.should.eql([]);
            res.headers["x-total-count"].should.eql("0");
        });
        it("Should return s1 and s2 ", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas")
                .query({q : JSON.stringify({ "_sis.owner" : ["sistest_rops"] }) })
                .expect(200);
            res.body.length.should.eql(2);
            for (var i = 0; i < 2; ++i) {
                res.body[i]._sis.owner.should.eql(['sistest_rops']);
            }
        });
    });

    describe("Schema regex", function() {
        it("Should fail for bad regex", async function() {
            var failures = [
                "/foo",
                "foo",
                "abc*",
                "//",
                "//g",
            ];
            await Promise.all(failures.map(function(f, idx) {
                var schema = {
                    name : "regex_fail_" + idx,
                    _sis : { owner : ['sistest'] },
                    definition : {
                        name : { type : "String", match : f }
                    }
                };
                return ApiServer.post("/api/v1.1/schemas").send(schema).expect(400);
            }));
        });

        it("Should add valid regex", async function() {
            var success = [
                "/foo/",
                "/^[0-9]+$/i",
                "/\\//"
            ];
            await Promise.all(success.map(async function(s, idx) {
                var schema = {
                    name : "regex_success_" + idx,
                    _sis : { owner : ["sistest"] },
                    definition : {
                        name : { type : "String", match : s }
                    }
                };
                await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
                await ApiServer.del("/api/v1.1/schemas/" + schema.name).expect(200);
            }));
        });

        it("Should add a digits only field", async function() {
            var schema = {
                name : "regex_digits",
                _sis : { owner : ["sistest"] },
                definition : {
                    digits : { type : "String", match : "/^[0-9]+$/" }
                }
            };
            var entities = [
                ["alkdjfa", 400],
                ["400", 201],
                ["502laksdjfa", 400],
                ["lkaadflkj2094852", 400],
                // mongoose always passes these
                ["", 201],
                ["0", 201]
            ];
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            await Promise.all(entities.map(function(e) {
                return ApiServer.post("/api/v1.1/entities/regex_digits")
                    .send({ digits : e[0] }).expect(e[1]);
            }));
            await ApiServer.del("/api/v1.1/schemas/regex_digits").expect(200);
        });
    });

    // TODO - move to v1 and v1.1 meta APIs
    describe("lock-schema", function() {
      var schema = {
        "name":"test_lock_entity",
        _sis : { owner : ["test"] },
        "locked_fields" : ["str", "num"],
        "definition": {
          "str":   "String",
          "num":   "Number",
          "date":  "Date",
          "bool":  "Boolean",
          "arr": []
        }
      };

      var schemaDoc = null;

      // create the schema and add an entity
      before(async function() {
          await ApiServer.del('/api/v1.1/schemas/' + schema.name);
          schemaDoc = (await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201)).body;
          schemaDoc._sis[SIS.FIELD_LOCKED].should.eql(false);
      });
      after(async function() {
          await ApiServer.del('/api/v1.1/schemas/' + schema.name).expect(200);
      });

      it("Should lock the schema", async function() {
          schemaDoc._sis[SIS.FIELD_LOCKED] = true;
          schemaDoc = (await ApiServer.put("/api/v1.1/schemas/" + schema.name)
              .send(schemaDoc).expect(200)).body;
          schemaDoc._sis[SIS.FIELD_LOCKED].should.eql(true);
      });

      it("Should not delete the schema", async function() {
          await ApiServer.del('/api/v1.1/schemas/' + schema.name)
              .expect(401);
      });

      it("Should unlock the schema", async function() {
          schemaDoc._sis[SIS.FIELD_LOCKED] = false;
          schemaDoc = (await ApiServer.put("/api/v1.1/schemas/" + schema.name)
              .send(schemaDoc).expect(200)).body;
          schemaDoc._sis[SIS.FIELD_LOCKED].should.eql(false);
      });

      it("Should prevent updating the schema with locked_fields", async function() {
          var obj = JSON.parse(JSON.stringify(schemaDoc));
          delete obj.definition.str;
          await ApiServer.put("/api/v1.1/schemas/" + schema.name)
              .send(obj).expect(400);
      });

      it("Should delete the date field", async function() {
          var obj = JSON.parse(JSON.stringify(schemaDoc));
          delete obj.definition.date;
          schemaDoc = (await ApiServer.put("/api/v1.1/schemas/" + schema.name)
              .send(obj).expect(200)).body;
          should.not.exist(schemaDoc.definition.date);
      });
      it("Should delete the str field", async function() {
          var obj = JSON.parse(JSON.stringify(schemaDoc));
          delete obj.definition.str;
          obj[SIS.FIELD_LOCKED_FIELDS] = ["num"];
          schemaDoc = (await ApiServer.put("/api/v1.1/schemas/" + schema.name)
              .send(obj).expect(200)).body;
          should.not.exist(schemaDoc.definition.str);
      });
    });

    describe("immutable schemas", function() {
        var schema = {
          "name":"test_immutable_schema",
          _sis : { "owner" : ["test"] },
          "definition": {
            "str":   "String"
          }
        };

        var schemaDoc = null;

        // create the schema and add an entity
        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/' + schema.name);
            schemaDoc = (await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201)).body;
            schemaDoc._sis[SIS.FIELD_LOCKED].should.eql(false);
        });
        after(async function() {
            await ApiServer.del('/api/v1.1/schemas/' + schema.name).expect(200);
        });

        it("Should mark the schema immutable and add num", async function() {
            var obj = JSON.parse(JSON.stringify(schemaDoc));
            obj._sis[SIS.FIELD_IMMUTABLE] = true;
            obj.definition.num = "Number";
            schemaDoc = (await ApiServer.put("/api/v1.1/schemas/" + schema.name)
                .send(obj).expect(200)).body;
            schemaDoc._sis[SIS.FIELD_IMMUTABLE].should.eql(true);
            schemaDoc.definition.num.should.eql("Number");
        });

        it("Should fail to update the schema", async function() {
           var obj = JSON.parse(JSON.stringify(schemaDoc));
           obj.definition.other = "Number";
           await ApiServer.put("/api/v1.1/schemas/" + schema.name)
               .send(obj).expect(401);
        });

        [
            ["owner", { owner : ["test", "test2"] }],
            ["tags", { tags : ["t1"] }],
            ["lock", { locked : true }],
            ["owner while making it mutable", { owner : ["test", "test2"], immutable : false }]
        ].forEach(function(change) {
            it("Should fail to change only the " + change[0] + " of the schema", async function() {
                var obj = JSON.parse(JSON.stringify(schemaDoc));
                Object.keys(change[1]).forEach(function(k) {
                    obj._sis[k] = change[1][k];
                });
                await ApiServer.put("/api/v1.1/schemas/" + schema.name)
                    .send(obj).expect(401);
                var res = await ApiServer.get("/api/v1.1/schemas/" + schema.name)
                    .expect(200);
                res.body._sis.should.eql(schemaDoc._sis);
            });
        });

        it("Should make the schema mutable", async function() {
            var obj = JSON.parse(JSON.stringify(schemaDoc));
            obj._sis[SIS.FIELD_IMMUTABLE] = false;
            schemaDoc = (await ApiServer.put("/api/v1.1/schemas/" + schema.name)
                .send(obj).expect(200)).body;
            schemaDoc._sis[SIS.FIELD_IMMUTABLE].should.eql(false);
        });

        it("Should update the schema now", async function() {
            var obj = JSON.parse(JSON.stringify(schemaDoc));
            obj.definition.other = "Number";
            var res = await ApiServer.put("/api/v1.1/schemas/" + schema.name)
                .send(obj).expect(200);
            res.body.definition.other.should.eql("Number");
        });
    });

    describe("with counts API", function() {
        var schema = {
          "name":"test_counts_schema",
          _sis : { "owner" : ["test"] },
          "definition": {
            "num":   "Number"
          }
        };
        var NUM_ENTITIES = 50;

        // create the schema and add entities
        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/' + schema.name);
            await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
            var entities = [];
            for (var i = 0; i < NUM_ENTITIES; ++i) {
                entities.push({
                    num : i
                });
            }
            var res = await ApiServer.post('/api/v1.1/entities/' + schema.name)
                .send(entities).expect(200);
            should.exist(res.body.success);
            should.exist(res.body.errors);
            res.body.success.should.be.instanceof(Array);
            res.body.success.length.should.eql(NUM_ENTITIES);
            res.body.errors.should.be.instanceof(Array);
            res.body.errors.length.should.eql(0);
        });
        after(async function() {
            await ApiServer.del('/api/v1.1/schemas/' + schema.name).expect(200);
        });
        // tests
        it("should not return total_counts by default", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas").expect(200);
            res.body.should.be.instanceof(Array);
            res.body.forEach(function(s) {
                s.should.not.have.property('entity_count');
            });
        });
        it("should not return total_counts by default (id)", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas/" + schema.name).expect(200);
            res.body.should.not.have.property('entity_count');
        });
        it("should fetch entity_count on schema list", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas").query({ with_counts : true })
                .expect(200);
            res.body.should.be.instanceof(Array);
            res.body.forEach(function(s) {
                s.should.have.property('entity_count');
                s.entity_count.should.be.instanceof(Number);
                if (s.name === schema.name) {
                    s.entity_count.should.eql(NUM_ENTITIES);
                }
            });
        });
        it("should fetch entity_count via ID", async function() {
            var res = await ApiServer.get("/api/v1.1/schemas/" + schema.name).query({with_counts : true})
                .expect(200);
            res.body.should.have.property('entity_count');
            res.body.entity_count.should.eql(NUM_ENTITIES);
        });
    });
});
