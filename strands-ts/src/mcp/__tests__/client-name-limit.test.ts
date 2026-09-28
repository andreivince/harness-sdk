import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createRandomTool } from '../../__fixtures__/tool-helpers.js'
import { logger } from '../../logging/index.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { McpClient } from '../client.js'
import { ToolValidationError } from '../../errors.js'

describe('McpClient', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('tool name limits', () => {
    it.each([false, true])('preserves direct prefixed calls with continueOnError=%s', async (continueOnError) => {
      // Agent registration limits do not restrict direct MCP invocation (#4513).
      const server = new McpServer({ name: 'aws-iac', version: '1.0.0' })
      const name = 'get_cloudformation_pre_deploy_validation_instructions'
      const result = { content: [{ type: 'text' as const, text: 'validation instructions' }] }
      server.registerTool(name, { inputSchema: {} }, async () => result)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new McpClient({
        transport: clientTransport,
        prefix: 'awslabs_aws-iac-mcp-server',
        continueOnError,
      })
      const agent = new Agent({ model: new MockMessageModel(), tools: [client], printer: false })
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        const tools = await client.listTools()
        expect(tools.map((tool) => tool.name)).toEqual([`awslabs_aws-iac-mcp-server_${name}`])
        expect(await client.callTool(tools[0]!, {})).toEqual(result)
        expect(warnSpy).not.toHaveBeenCalled()
        if (continueOnError) {
          await agent.initialize()
          expect(agent.tools).toEqual([])
          expect(client.toolWarnings).toEqual([expect.stringContaining(name)])
          const warnings = [...client.toolWarnings]
          await client.listTools({ prefix: '' })
          expect(client.toolWarnings).toEqual(warnings)
        } else {
          await expect(agent.initialize()).rejects.toThrow(ToolValidationError)
        }
        const rediscovered = await client.listTools()
        expect(await client.callTool(rediscovered[0]!, {})).toEqual(result)
      } finally {
        await client.disconnect()
        await server.close()
      }
    })

    it('updates omitted-tool warnings as a lenient server loses and recovers tools', async () => {
      const server = new McpServer({ name: 'test', version: '1.0.0' })
      const oldTool = server.registerTool('old', { inputSchema: {} }, async () => ({ content: [] }))
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new McpClient({ transport: clientTransport, prefix: 'server', continueOnError: true })
      const agent = new Agent({ model: new MockMessageModel(), tools: [client], printer: false })
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        await agent.initialize()
        expect(client.toolWarnings).toEqual([])
        const invalidTool = server.registerTool('a'.repeat(58), { inputSchema: {} }, async () => ({ content: [] }))
        await vi.waitFor(() => expect(client.toolWarnings).toHaveLength(1))
        expect(agent.tools.map((tool) => tool.name)).toEqual(['server_old'])
        oldTool.remove()
        await vi.waitFor(() => expect(agent.tools).toEqual([]))
        expect(client.toolWarnings).toHaveLength(1)
        invalidTool.remove()
        server.registerTool('new', { inputSchema: {} }, async () => ({ content: [] }))
        await vi.waitFor(() => expect(agent.tools.map((tool) => tool.name)).toEqual(['server_new']))
        expect(client.toolWarnings).toEqual([])
      } finally {
        await client.disconnect()
        await server.close()
      }
    })

    it('retains the registered tools across strict refresh failure and direct rediscovery', async () => {
      const server = new McpServer({ name: 'test', version: '1.0.0' })
      const oldTool = server.registerTool('old', { inputSchema: {} }, async () => ({ content: [] }))
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new McpClient({ transport: clientTransport, prefix: 'server' })
      const agent = new Agent({ model: new MockMessageModel(), tools: [client], printer: false })
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        await agent.initialize()
        const invalidTool = server.registerTool('a'.repeat(58), { inputSchema: {} }, async () => ({ content: [] }))
        await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to refresh tools')))
        expect(agent.tools.map((tool) => tool.name)).toEqual(['server_old'])
        await client.listTools({ prefix: 'direct' })
        invalidTool.remove()
        oldTool.remove()
        server.registerTool('new', { inputSchema: {} }, async () => ({ content: [] }))
        await vi.waitFor(() => expect(agent.tools.map((tool) => tool.name)).toEqual(['server_new']))
      } finally {
        await client.disconnect()
        await server.close()
      }
    })

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
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(
          serverNames.map((name) => `${prefix}_${name}`)
        )
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
