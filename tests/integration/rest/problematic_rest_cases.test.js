// problematic_rest_cases.test.js
// Tests for problematic REST endpoint cases found in production
// Based on cases from ~/Downloads/Problematic Rest Cases

import test from 'ava';
import got from 'got';
import serverFactory from '../../../index.js';

const API_BASE = `http://localhost:${process.env.CORTEX_PORT}/v1`;

let testServer;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

test('POST /chat/completions - tool message with string content (debug-req-body.json case)', async (t) => {
  // Case from debug-req-body.json: Tool message with string content (not array)
  // This tests that tool messages with string content are handled correctly
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: 'Use the execute_python_code tool to create a CSV file with sample data. When done, say \'EXECUTION COMPLETE\'.'
        },
        {
          role: 'user',
          name: 'user',
          content: 'Create a CSV file with 5 rows of sample data using the available tools.'
        },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_LJ61zOGEbIdiwkMTXEpcmeqM',
            function: {
              arguments: '{"code":"import pandas as pd\\n\\ndata = {\\n    \'ID\': [1, 2, 3, 4, 5],\\n    \'Name\': [\'Alice\', \'Bob\', \'Charlie\', \'David\', \'Eve\'],\\n    \'Age\': [25, 30, 35, 28, 22],\\n    \'Country\': [\'USA\', \'UK\', \'Canada\', \'Australia\', \'Germany\']\\n}\\ndf = pd.DataFrame(data)\\ndf.to_csv(\'sample_data.csv\', index=False)\\n\'Sample CSV file created as sample_data.csv.\'"}',
              name: 'execute_python_code'
            },
            type: 'function'
          }],
          content: null
        },
        {
          role: 'tool',
          content: '📁 Ready for upload: /var/folders/gk/lhywp4nj7jd3n6_qhwxk9b7w0000gn/T/tmp_h9x7u5j\nCODE EXECUTION SUCCESSFUL - Files created.', // String content, not array
          tool_call_id: 'call_LJ61zOGEbIdiwkMTXEpcmeqM'
        }
      ],
      model: 'gpt-4.1',
      stream: false,
      tool_choice: 'auto',
      tools: [{
        type: 'function',
        function: {
          name: 'execute_python_code',
          description: 'Execute Python code using LocalCommandLineCodeExecutor with available functions like load_data()',
          parameters: {
            type: 'object',
            properties: {
              code: {
                description: 'code',
                title: 'Code',
                type: 'string'
              }
            },
            required: ['code'],
            additionalProperties: false
          },
          strict: false
        }
      }]
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - system message with array content (debug-req-body2.json case)', async (t) => {
  // Case from debug-req-body2.json: System message with array content (text type)
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: '=== AUTONOMOUS OPERATION ===\n    You operate FULLY AUTONOMOUSLY. No user interaction available after task submission.'
          }] // Array content
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Fetch the latest top wires, AJA (Arabic), and AJE (English) news headlines for today.'
          }],
          name: 'user'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with empty string content and tool_calls', async (t) => {
  // Case from debug-req-body2.json: Assistant message with empty string content and tool_calls
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Test message'
          }],
          name: 'user'
        },
        {
          role: 'assistant',
          content: '', // Empty string content
          tool_calls: [{
            id: 'call_6uZewQMkYolO6dZ26t3ifbko',
            function: {
              arguments: '{"query": "SELECT id, post_title AS headline", "database": "ucms_aje"}',
              name: 'execute_aj_sql_query'
            },
            type: 'function'
          }]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with content array containing strings (should be converted to objects)', async (t) => {
  // This tests the fix: content arrays cannot have standalone strings - they must be text content objects
  // This is the actual bug from debug-req-body2.json and debug-req-body3.json
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Test message'
          }]
        },
        {
          role: 'assistant',
          content: [''], // Array with string - should be converted to [{type: 'text', text: ''}]
          tool_calls: [{
            id: 'call_test123',
            function: {
              arguments: '{"param": "value"}',
              name: 'test_function'
            },
            type: 'function'
          }]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
  // The request should succeed because the plugin converts [""] to [{"type": "text", "text": ""}]
});

test('POST /chat/completions - tool message with string error content', async (t) => {
  // Case from debug-req-body2.json: Tool message with string content containing error JSON
  
  const errorContent = "{'success': False, 'error': '(pymysql.err.ProgrammingError) (1064, \"You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near \\'utc_date, \\'wire\\' AS source\\\\nFROM ucms_aje.wp_posts\\\\nWHERE post_status = \\'publish\\'\\\\n\\' at line 1\")\\n[SQL: SELECT id, post_title AS headline, post_date_gmt AS utc_date, \\'wire\\' AS source\\nFROM ucms_aje.wp_posts\\nWHERE post_status = \\'publish\\'\\n  AND post_type IN (\\'ajwire\\', \\'aje_wire\\')\\n  AND post_date_gmt >= UTC_TIMESTAMP() - INTERVAL 1 DAY\\nORDER BY post_date_gmt DESC\\nLIMIT 30;]\\n(Background on this error at: https://sqlalche.me/e/20/f405)', 'requested_database': 'ucms_aje'}";
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_6uZewQMkYolO6dZ26t3ifbko',
            function: {
              arguments: '{"query": "SELECT id, post_title AS headline", "database": "ucms_aje"}',
              name: 'execute_aj_sql_query'
            },
            type: 'function'
          }]
        },
        {
          role: 'tool',
          content: errorContent, // String content with error JSON
          tool_call_id: 'call_6uZewQMkYolO6dZ26t3ifbko'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - multiple tool calls in sequence', async (t) => {
  // Case from debug-req-body2.json: Multiple tool calls in sequence
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_m3qj0e159yerL7LolOvvX7UC',
              function: {
                arguments: '{"query": "SELECT DATE(post_date) AS publish_day", "database": "ucms_aje"}',
                name: 'execute_aj_sql_query'
              },
              type: 'function'
            },
            {
              id: 'call_m3DAPXSNBDaJ5ZgOWiboz1aC',
              function: {
                arguments: '{"query": "SELECT DATE(post_date) AS publish_day", "database": "ucms_aja"}',
                name: 'execute_aj_sql_query'
              },
              type: 'function'
            }
          ]
        },
        {
          role: 'tool',
          content: "{'success': True, 'results': [], 'columns': ['publish_day', 'article_count'], 'row_count': 0}",
          tool_call_id: 'call_m3qj0e159yerL7LolOvvX7UC'
        },
        {
          role: 'tool',
          content: "{'success': True, 'results': [], 'columns': ['publish_day', 'article_count'], 'row_count': 0}",
          tool_call_id: 'call_m3DAPXSNBDaJ5ZgOWiboz1aC'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - messages with name fields (user and assistant)', async (t) => {
  // Case from debug-req-body.json and selectortestsimple.py: Messages with name fields
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          name: 'user',
          content: 'Create a Python function that calculates the factorial of a number and test it with input 5'
        },
        {
          role: 'assistant',
          name: 'planner_agent',
          content: '[PLANNER_AGENT ACTIVE]\n\nStep-by-step execution plan:\n\n1. Define a Python function called factorial(n)'
        },
        {
          role: 'user',
          name: 'coder_agent',
          content: '[CODER_AGENT ACTIVE]\n```python\n# Factorial function with error handling\ndef factorial(n):'
        },
        {
          role: 'user',
          name: 'code_executor_agent',
          content: '{"status": "success", "execution_time": 0.001, "output": "Function defined successfully. Test: factorial(5) = 120"}'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - complex multi-turn conversation with tool calls and name fields', async (t) => {
  // Case from debug-req-body3.json: Complex multi-turn conversation
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: '=== AUTONOMOUS OPERATION ===\n    You operate FULLY AUTONOMOUSLY.'
          }]
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Prepare a presentation comparing the top publish days for Al Jazeera Arabic (AJA) and Al Jazeera English (AJE) for the current year.'
          }],
          name: 'user'
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Transferred to aj_sql_agent, adopting the role of aj_sql_agent immediately.'
          }],
          name: 'planner_agent'
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_m3qj0e159yerL7LolOvvX7UC',
              function: {
                arguments: '{"query": "SELECT DATE(post_date) AS publish_day, COUNT(*) AS article_count\\nFROM wp_posts\\nWHERE post_type = \'article\'\\n  AND post_status = \'publish\'\\n  AND post_date >= \'2024-01-01\'\\n  AND post_date < CURDATE()\\nGROUP BY publish_day\\nORDER BY publish_day;", "database": "ucms_aje", "work_dir": "/tmp/coding/req_5e2eac98-05c5-459b-9d2f-77478561f572"}',
                name: 'execute_aj_sql_query'
              },
              type: 'function'
            },
            {
              id: 'call_m3DAPXSNBDaJ5ZgOWiboz1aC',
              function: {
                arguments: '{"query": "SELECT DATE(post_date) AS publish_day, COUNT(*) AS article_count\\nFROM wp_posts\\nWHERE post_type = \'article\'\\n  AND post_status = \'publish\'\\n  AND post_date >= \'2024-01-01\'\\n  AND post_date < CURDATE()\\nGROUP BY publish_day\\nORDER BY publish_day;", "database": "ucms_aja", "work_dir": "/tmp/coding/req_5e2eac98-05c5-459b-9d2f-77478561f572"}',
                name: 'execute_aj_sql_query'
              },
              type: 'function'
            }
          ]
        },
        {
          role: 'tool',
          content: "{'success': True, 'results': [], 'columns': ['publish_day', 'article_count'], 'row_count': 0, 'data_location': 'inline', 'database': 'ucms_aje', 'is_empty': True, 'warning': '⚠️ WARNING: Query returned empty results. Do NOT create charts or generate insights from empty data. Report the empty result clearly instead.'}",
          tool_call_id: 'call_m3qj0e159yerL7LolOvvX7UC'
        },
        {
          role: 'tool',
          content: "{'success': True, 'results': [], 'columns': ['publish_day', 'article_count'], 'row_count': 0, 'data_location': 'inline', 'database': 'ucms_aja', 'is_empty': True, 'warning': '⚠️ WARNING: Query returned empty results. Do NOT create charts or generate insights from empty data. Report the empty result clearly instead.'}",
          tool_call_id: 'call_m3DAPXSNBDaJ5ZgOWiboz1aC'
        }
      ],
      temperature: 0.9,
      stream: false,
      tools: [{
        type: 'function',
        function: {
          name: 'execute_aj_sql_query',
          description: 'Execute SQL queries against Al Jazeera databases (ucms_aje, ucms_aja, ucms_ajb, ucms_ajd). Returns JSON results for analysis and visualization.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                description: 'query',
                title: 'Query',
                type: 'string'
              },
              database: {
                default: null,
                description: 'database',
                title: 'Database',
                type: 'string'
              },
              work_dir: {
                default: null,
                description: 'work_dir',
                title: 'Work Dir',
                type: 'string'
              }
            },
            required: ['query'],
            additionalProperties: false
          },
          strict: false
        }
      }],
      tool_choice: 'auto',
      max_tokens: 8192
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with content array containing string (retry after error)', async (t) => {
  // Case from debug-req-body2.json and debug-req-body3.json: Assistant retries after tool error
  // with content as array containing a string (not an object) - this is the actual bug case
  // In debug-req-body2.json line 124-125: "content": ["All three headline fetch queries failed..."]
  // In debug-req-body3.json line 77-78: "content": ["Both queries failed because..."]
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_6uZewQMkYolO6dZ26t3ifbko',
            function: {
              arguments: '{"query": "SELECT id, post_title AS headline, post_date_gmt AS utc_date, \'wire\' AS source\\nFROM ucms_aje.wp_posts", "database": "ucms_aje"}',
              name: 'execute_aj_sql_query'
            },
            type: 'function'
          }]
        },
        {
          role: 'tool',
          content: "{'success': False, 'error': '(pymysql.err.ProgrammingError) (1064, \"You have an error in your SQL syntax\")'}",
          tool_call_id: 'call_6uZewQMkYolO6dZ26t3ifbko'
        },
        {
          role: 'assistant',
          content: [
            'Both queries failed because the wp_posts table does not have a column named publish_date. This is a common issue in WordPress schemas. The correct column for the publish date is likely post_date (the canonical WordPress field for when an item was published).\n\nI will rerun the necessary queries using post_date in place of publish_date to extract the daily publish counts for both Al Jazeera English (AJE) and Al Jazeera Arabic (AJA) for 2024.'
          ], // Array with string - this is the bug! Should be converted to [{type: 'text', text: '...'}]
          tool_calls: [{
            id: 'call_xwXHc4fTmgUt4yO14ndxYib7',
            function: {
              arguments: '{"query": "SELECT DATE(post_date) AS publish_day, COUNT(*) AS article_count\\nFROM wp_posts\\nWHERE post_type = \'article\'\\n  AND post_status = \'publish\'\\n  AND post_date >= \'2024-01-01\'\\n  AND post_date < CURDATE()\\nGROUP BY publish_day\\nORDER BY publish_day;", "database": "ucms_aje"}',
              name: 'execute_aj_sql_query'
            },
            type: 'function'
          }]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
  // The request should succeed because the plugin converts ["string"] to [{"type": "text", "text": "string"}]
});

