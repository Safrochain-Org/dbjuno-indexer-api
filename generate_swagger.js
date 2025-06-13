// Script to read db-uri from postgrest.conf and generate a basic OpenAPI (Swagger) spec
// Usage: node generate_swagger.js

const fs = require('fs');
const { Client } = require('pg');
const path = require('path');
const yaml = require('js-yaml');

const CONF_PATH = path.join(__dirname, 'postgrest.conf');

function getDbUri(confPath) {
    const conf = fs.readFileSync(confPath, 'utf-8');
    const match = conf.match(/db-uri\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('db-uri not found');
    return match[1];
}

async function getTablesAndColumns(client) {
    const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  `);
    const result = {};
    for (const row of tables.rows) {
        const columns = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = $1;
    `, [row.table_name]);
        result[row.table_name] = columns.rows;
    }
    return result;
}

function generateOpenApi(tables) {
    const servers = [
        {
            url: 'http://localhost:3005',
            description: 'Local PostgREST server'
        }
    ];
    const paths = {};
    for (const [table, columns] of Object.entries(tables)) {
        // Generate query parameters for filtering, limit, offset, order, etc.
        const parameters = [
            {
                name: 'limit',
                in: 'query',
                description: 'Maximum number of results to return',
                required: false,
                schema: { type: 'integer', minimum: 1 }
            },
            {
                name: 'offset',
                in: 'query',
                description: 'Number of results to skip',
                required: false,
                schema: { type: 'integer', minimum: 0 }
            },
            {
                name: 'order',
                in: 'query',
                description: 'Order results by column (e.g. col.asc, col.desc)',
                required: false,
                schema: { type: 'string' }
            },
            // Add filter parameters for each column
            ...columns.map(col => ({
                name: col.column_name,
                in: 'query',
                description: `Filter by ${col.column_name} (${col.data_type})`,
                required: false,
                schema: { type: mapType(col.data_type) }
            }))
        ];
        // Add Accept and Prefer headers as parameters
        const headers = [
            {
                name: 'Accept',
                in: 'header',
                description: 'Response media type',
                required: false,
                schema: { type: 'string', default: 'application/json' }
            },
            {
                name: 'Prefer',
                in: 'header',
                description: 'PostgREST preferences (e.g. return=representation)',
                required: false,
                schema: { type: 'string' }
            }
        ];
        paths[`/${table}`] = {
            get: {
                summary: `List ${table}`,
                parameters: [...parameters, ...headers],
                responses: {
                    200: {
                        description: 'Successful response',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: Object.fromEntries(
                                            columns.map(col => [col.column_name, { type: mapType(col.data_type) }])
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
    }
    return {
        openapi: '3.0.0',
        info: {
            title: 'PostgREST API',
            version: '1.0.0'
        },
        servers,
        paths
    };
}

function mapType(pgType) {
    switch (pgType) {
        case 'integer': return 'integer';
        case 'boolean': return 'boolean';
        case 'text':
        case 'character varying':
        case 'character':
            return 'string';
        case 'timestamp without time zone':
        case 'timestamp with time zone':
        case 'date':
            return 'string';
        case 'numeric':
        case 'double precision':
        case 'real':
            return 'number';
        default:
            return 'string';
    }
}

(async () => {
    try {
        const dbUri = getDbUri(CONF_PATH);
        const client = new Client({ connectionString: dbUri });
        await client.connect();
        const tables = await getTablesAndColumns(client);
        await client.end();
        const openapi = generateOpenApi(tables);
        fs.writeFileSync('swagger.json', JSON.stringify(openapi, null, 2));
        // Write YAML version
        const swaggerYaml = yaml.dump(openapi, { noRefs: true });
        fs.writeFileSync('swagger.yml', swaggerYaml);
        console.log('swagger.json and swagger.yml generated successfully.');
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
})();
