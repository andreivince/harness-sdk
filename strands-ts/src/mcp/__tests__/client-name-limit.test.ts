import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createRandomTool } from '../../__fixtures__/tool-helpers.js'
import { logger } from '../../logging/index.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { McpClient } from '../client.js'

describe('McpClient', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('tool name limits', () => {
    it.each([
      { prefix: 'awslabs_aws-iac-mcp-server', skipped: 3 },
      { prefix: 'aws-iac', skipped: 0 },
    ])('initializes and invokes surviving tools with prefix $prefix', async ({ prefix, skipped }) => {
      // Overlong MCP names cannot abort initialization of valid tools (#4513).
      const server = new McpServer({ name: 'aws-iac', version: '1.0.0' })
      const longNames = [
        'get_cloudformation_pre_deploy_validation_instructions',
        'check_cloudformation_template_compliance',
        'troubleshoot_cloudformation_deployment',
      ]
      const serverNames = [...longNames, 'list_stacks']
      const executeTool = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'stack list' }],
      }))
      for (const name of serverNames) {
        server.registerTool(name, { description: `Execute ${name}`, inputSchema: {} }, executeTool)
      }
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new McpClient({ transport: clientTransport, prefix, continueOnError: true })
      const model = new MockMessageModel()
      const agent = new Agent({ model, tools: [createRandomTool('local_tool'), client], printer: false })
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      try {
        await agent.initialize()
        const expectedNames = (skipped ? ['list_stacks'] : serverNames).map((name) => `${prefix}_${name}`)
        expect(agent.tools.map((tool) => tool.name)).toEqual(['local_tool', ...expectedNames])
        expect(warnSpy).toHaveBeenCalledTimes(skipped)

        // Rediscovery must not break routing of tool objects already registered with the agent.
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(expectedNames)
        model
          .addTurn({ type: 'toolUseBlock', name: `${prefix}_list_stacks`, toolUseId: 'stacks', input: {} })
          .addTurn({ type: 'textBlock', text: 'Listed stacks' })
        await agent.invoke('List stacks')

        const toolResults = agent.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'toolResultBlock')
        expect(toolResults).toEqual([
          new ToolResultBlock({
            toolUseId: 'stacks',
            status: 'success',
            content: [new TextBlock('stack list')],
          }),
        ])
        expect(executeTool).toHaveBeenCalledTimes(1)
      } finally {
        await client.disconnect()
        await server.close()
      }
    })
  })
})
