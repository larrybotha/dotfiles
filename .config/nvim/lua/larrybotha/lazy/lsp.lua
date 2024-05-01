--- @param event object
local function configureKeyMaps(event)
	local setKeymap = vim.keymap.set
	local lspBuf = vim.lsp.buf
	local opts = { buffer = event.buf }

	setKeymap("n", "<C-]>", lspBuf.definition, opts)
	setKeymap("n", "<C-k>", lspBuf.signature_help, opts)
	setKeymap("n", "<leader>rn", lspBuf.rename, opts)
	setKeymap("n", "K", lspBuf.hover, opts)
	setKeymap("n", "[d", vim.diagnostic.goto_prev, opts)
	setKeymap("n", "]d", vim.diagnostic.goto_next, opts)
	setKeymap("n", "gD", lspBuf.declaration, opts)
	setKeymap("n", "gd", lspBuf.definition, opts) -- go to where symbol is defined
	setKeymap("n", "gi", lspBuf.implementation, opts) -- go to implementation, e.g. with interfaces
	setKeymap({ "n", "v" }, "<space>ca", lspBuf.code_action, opts)

	-- Enable completion triggered by <c-x><c-o> (overridden by nvim-cmp, below)
	vim.bo[event.buf].omnifunc = "v:lua.vim.lsp.omnifunc"
end

local function configureMasonLsp(capabilities)
	local lspconfig = require("lspconfig")

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
			"html",
			"htmx",
			"jsonls",
			"lua_ls",
			"marksman",
			"pyright",
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
				lspconfig[server_name].setup({ capabilities = capabilities })
			end,

			["lua_ls"] = function()
				lspconfig.lua_ls.setup({
					capabilities = capabilities,
					settings = {
						Lua = {
							completion = {
								callSnippet = "Replace", -- see https://github.com/folke/neodev.nvim
							},
						},
					},
				})
			end,

			["eslint"] = function()
				lspconfig.eslint.setup({
					capabilities = capabilities,
					settings = { command = "eslint_d" },
				})
			end,

			["html"] = function()
				lspconfig.html.setup({
					capabilities = capabilities,
					filetypes = { "html", "htmldjango" },
				})
			end,

			["htmx"] = function()
				lspconfig.htmx.setup({
					capabilities = capabilities,
					filetypes = { "html", "htmldjango" },
				})
			end,

			["pyright"] = function()
				lspconfig.pyright.setup({
					capabilities = capabilities,
					settings = {
						python = {
							-- use pyright _only_ for renaming in Python, not diagnostics
							analysis = {
								diagnosticMode = "off",
								typeCheckingMode = "off",
							},
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
			["<C-e>"] = cmp.mapping.abort(),
			["<C-x><C-o>"] = cmp.mapping.complete(), -- replace Vim's omnifunc
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
	})

	return capabilities
end

return {
	"neovim/nvim-lspconfig",
	dependencies = {
		"L3MON4D3/LuaSnip",
		"folke/neodev.nvim", -- neovim Lua deps
		"hrsh7th/cmp-buffer",
		"hrsh7th/cmp-cmdline",
		"hrsh7th/cmp-nvim-lsp",
		"hrsh7th/cmp-nvim-lsp-document-symbol",
		"hrsh7th/cmp-nvim-lsp-signature-help",
		"hrsh7th/cmp-nvim-lua",
		"hrsh7th/cmp-path",
		"hrsh7th/nvim-cmp",
		"j-hui/fidget.nvim",
		"saadparwaiz1/cmp_luasnip",
		"williamboman/mason-lspconfig.nvim",
		"williamboman/mason.nvim",
	},
	config = function()
		require("neodev").setup({}) -- must be called before configured lsp
		require("fidget").setup({})

		local capabilities = configureCmp()

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

		vim.api.nvim_create_autocmd("LspAttach", {
			group = vim.api.nvim_create_augroup("CustomLspConfig", {}),
			callback = configureKeyMaps,
		})
	end,
}
