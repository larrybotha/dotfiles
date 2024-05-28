--- @param event object
local function configureKeyMaps(event)
	local setKeymap = vim.keymap.set
	local lspBuf = vim.lsp.buf
	local opts = { buffer = event.buf }

	setKeymap("n", "<C-]>", lspBuf.definition, opts)
	setKeymap("i", "<C-S>", lspBuf.signature_help, opts)
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

local function configureMasonLsp()
	local lspconfig = require("lspconfig")
	local capabilities = vim.tbl_deep_extend(
		"force",
		{},
		vim.lsp.protocol.make_client_capabilities(),
		require("cmp_nvim_lsp").default_capabilities()
	)

	local opts = {
		ensure_installed = {
			"ansiblels",
			"bashls",
			"biome",
			"cssls",
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

			["denols"] = function()
				lspconfig.denols.setup({ autostart = false })
			end,

			["biome"] = function()
				lspconfig.biome.setup({
					capabilities = capabilities,
					-- enable biome when package.json is present, in addition to defaults
					root_dir = require("lspconfig.util").root_pattern("biome.json", "biome.jsonc", "package.json"),
					-- enable biome even when not in a biome project
					single_file_support = true,
				})
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

			["rust_analyzer"] = function()
				lspconfig.htmx.setup({
					capabilities = capabilities,
					diagnostics = {
						enable = false,
					},
					settings = {
						-- to enable rust-analyzer settings visit:
						-- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
						["rust-analyzer"] = {
							-- enable clippy on save
							checkOnSave = {
								command = "clippy",
							},
						},
					},
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

require("neodev").setup({}) -- must be called before configured lsp
require("fidget").setup({})

configureMasonLsp()

vim.diagnostic.config({
	-- update_in_insert = true,
	float = {
		focusable = false,
		style = "minimal",
		border = "rounded",
		source = true,
		header = "",
		prefix = "",
	},
})

vim.api.nvim_create_autocmd("LspAttach", {
	group = vim.api.nvim_create_augroup("CustomLspConfig", {}),
	callback = configureKeyMaps,
})
