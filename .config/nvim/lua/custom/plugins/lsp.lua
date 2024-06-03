local function configureLsp()
	local lspconfig = require("lspconfig")
	local capabilities = vim.tbl_deep_extend(
		"force",
		{},
		vim.lsp.protocol.make_client_capabilities(),
		require("cmp_nvim_lsp").default_capabilities()
	)
	local servers = {
		denols = { autostart = false },
		biome = {
			-- enable biome when package.json is present, in addition to defaults
			root_dir = require("lspconfig.util").root_pattern("biome.json", "biome.jsonc", "package.json"),
			-- enable biome even when not in a biome project
			single_file_support = true,
		},

		eslint = { settings = { command = "eslint_d" } },

		gopls = {
			settings = {
				gopls = {
					hints = {
						assignVariableTypes = true,
						compositeLiteralFields = true,
						compositeLiteralTypes = true,
						constantValues = true,
						functionTypeParameters = true,
						parameterNames = true,
						rangeVariableTypes = true,
					},
				},
			},
		},

		html = { filetypes = { "html", "htmldjango" } },
		htmx = { filetypes = { "html", "htmldjango" } },

		rust_analyzer = {
			diagnostics = { enable = false },
			settings = {
				-- to enable rust-analyzer settings visit:
				-- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
				["rust-analyzer"] = {
					-- enable clippy on save
					checkOnSave = { command = "clippy" },
				},
			},
		},

		pyright = {
			settings = {
				python = {
					-- use pyright _only_ for renaming in Python, not diagnostics
					analysis = {
						diagnosticMode = "off",
						typeCheckingMode = "off",
					},
				},
			},
		},

		jsonls = {
			settings = {
				json = {
					schemas = require("schemastore").json.schemas(),
					validate = { enable = true },
				},
			},
		},

		yamlls = {
			settings = {
				yaml = {
					schemaStore = { enable = false, url = "" },
					schemas = require("schemastore").yaml.schemas(),
				},
			},
		},

		ansiblels = true,
		bashls = true,
		cmake = true,
		css_variables = true,
		cssls = true,
		docker_compose_language_service = true,
		dockerls = true,
		emmet_ls = true,
		gitlab_ci_ls = true,
		lua_ls = true,
		marksman = true,
		ruff_lsp = true,
		somesass_ls = true,
		sqlls = true,
		svelte = true,
		tailwindcss = true,
		taplo = true,
		templ = true,
		terraformls = true,
		tsserver = true,
		vimls = true,
	}
	local ensure_installed = {}

	for name, _ in pairs(servers) do
		vim.list_extend(ensure_installed, { name })
	end

	require("custom.plugins.mason").setup()
	-- must come _after_ mason.setup()
	require("mason-lspconfig").setup({
		ensure_installed = ensure_installed,
		automatic_installation = true,
	})

	for name, config in pairs(servers) do
		if config == true then
			config = {}
		end
		config = vim.tbl_deep_extend("force", {}, {
			capabilities = capabilities,
		}, config)

		lspconfig[name].setup(config)
	end
end

require("fidget").setup({})

configureLsp()

vim.diagnostic.config({
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
	callback = function(event)
		local setKeymap = vim.keymap.set
		local lspBuf = vim.lsp.buf
		---@type vim.keymap.set.Opts
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
	end,
})
