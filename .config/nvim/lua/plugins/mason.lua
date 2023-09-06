local mason = require("mason")

local options = {
	-- custom property for storing list of packages to install
	_custom_ensure_installed = {
		-- diagnostics
		"alex",
		"ansible-lint",
		"biome",
		"codespell",
		"djlint",
		"eslint_d",
		"hadolint",
		"mypy",
		"revive",
		"ruff",
		"selene",
		"semgrep",
		"shellcheck",
		"shellharden",
		"sqlfluff",
		"stylelint",
		"tfsec",
		"vint",
		"vulture",
		"yamllint",

		-- formatters
		"blackd-client",
		"cbfmt",
		"djlint",
		"eslint_d",
		"fixjson",
		"goimports",
		"isort",
		"prettierd",
		"rustfmt",
		"shellharden",
		"shfmt",
		"stylua",
		"taplo",
	},
	max_concurrent_installers = 10,
	PATH = "append", -- prefer local packages if they exist
}

mason.setup(options)

require("mason-lspconfig").setup({
	ensure_installed = {
		"ansiblels",
		"bashls",
		"cssls",
		"denols",
		"docker_compose_language_service",
		"dockerls",
		"emmet_ls",
		"eslint",
		"gopls",
		"html",
		"jsonls",
		"lua_ls",
		"marksman",
		"pyright",
		"biome",
		"ruff_lsp",
		"rust_analyzer",
		"svelte",
		"taplo",
		"terraformls",
		"tsserver",
		"vimls",
		"yamlls",
	},
})

vim.api.nvim_create_user_command("MasonInstallCustom", function()
	vim.cmd("MasonInstall " .. table.concat(options._custom_ensure_installed, " "))
end, {})
