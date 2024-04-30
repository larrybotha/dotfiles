local function configureMasonLsp(capabilities)
	local opts = {
		ensure_installed = {
			"ansiblels",
			"bashls",
			"biome",
			"cssls",
			"denols",
			"docker_compose_language_service",
			"dockerls",
			"emmet_ls",
			"eslint",
			"gopls",
			"gopls",
			"html",
			"htmx",
			"jsonls",
			"lua_ls",
			"marksman",
			"ruff_lsp",
			"rust_analyzer",
			"svelte",
			"taplo",
			"terraformls",
			"tsserver",
			"vimls",
			"yamlls",
		},
		handlers = {
			function(server_name) -- default handler (optional)
				require("lspconfig")[server_name].setup({
					capabilities = capabilities,
				})
			end,

			["lua_ls"] = function()
				local lspconfig = require("lspconfig")

				lspconfig.lua_ls.setup({
					capabilities = capabilities,
					settings = {
						Lua = {
							runtime = { version = "Lua 5.1" },
							diagnostics = { globals = { "vim" } },
						},
					},
				})
			end,
		},
	}

	require("mason-lspconfig").setup(opts)
end

local function configureCmp()
	local cmp = require("cmp")
	local capabilities = vim.tbl_deep_extend(
		"force",
		{},
		vim.lsp.protocol.make_client_capabilities(),
		require("cmp_nvim_lsp").default_capabilities()
	)

	cmp.setup({
		snippet = {
			expand = function(args)
				require("luasnip").lsp_expand(args.body)
			end,
		},
		mapping = cmp.mapping.preset.insert({
			["<C-b>"] = cmp.mapping.scroll_docs(-4),
			["<C-f>"] = cmp.mapping.scroll_docs(4),
			["<C-Space>"] = cmp.mapping.complete(),
			["<C-e>"] = cmp.mapping.abort(),
			["<CR>"] = cmp.mapping.confirm({ select = true }),
		}),
		sources = cmp.config.sources({
			-- order matters
			{ name = "nvim_lua" }, -- Neovim lua API
			{ name = "luasnip" },
			{ name = "nvim_lsp" },
			{ name = "nvim_lsp_document_symbol" },
			{ name = "nvim_lsp_signature_help" },
			{ name = "path" },
			{ name = "buffer", keyword_length = 5 },
		}),
	})

	-- Use buffer source for `/` and `?`
	cmp.setup.cmdline({ "/", "?" }, {
		mapping = cmp.mapping.preset.cmdline(),
		sources = {
			{ name = "buffer" },
		},
	})

	-- Use cmdline & path source for ':'
	cmp.setup.cmdline(":", {
		mapping = cmp.mapping.preset.cmdline(),
		sources = cmp.config.sources({
			{ name = "path" },
		}, {
			{ name = "cmdline" },
		}),
		matching = { disallow_symbol_nonprefix_matching = false },
	})

	return capabilities
end

return {
	"neovim/nvim-lspconfig",
	dependencies = {
		"L3MON4D3/LuaSnip",
		"hrsh7th/cmp-buffer",
		"hrsh7th/cmp-cmdline",
		"hrsh7th/cmp-nvim-lsp",
		"hrsh7th/cmp-nvim-lsp-signature-help",
		"hrsh7th/cmp-nvim-lua",
		"hrsh7th/cmp-nvim-lsp-document-symbol",
		"hrsh7th/cmp-path",
		"hrsh7th/nvim-cmp",
		"j-hui/fidget.nvim",
		"saadparwaiz1/cmp_luasnip",
		"williamboman/mason-lspconfig.nvim",
		"williamboman/mason.nvim",
	},
	config = function()
		local capabilities = configureCmp()

		require("fidget").setup({})

		configureMasonLsp(capabilities)

		vim.diagnostic.config({
			-- update_in_insert = true,
			float = {
				focusable = false,
				style = "minimal",
				border = "rounded",
				source = "always",
				header = "",
				prefix = "",
			},
		})
	end,
}
