local M = {}

M.setup = function()
	local ensure_installed = {
		-- dap
		"debugpy",

		-- diagnostics / none-ls | null-ls
		"alex",
		"ansible-lint",
		"biome",
		"codespell",
		"djlint",
		"eslint_d",
		"hadolint",
		"mypy",
		"pyright",
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
		"yamllint",

		-- formatters
		"cbfmt",
		"gofumpt",
		"djlint",
		"eslint_d",
		"fixjson",
		"goimports",
		"prettierd",
		"shellharden",
		"shfmt",
		"stylua",
		"taplo",
		--"rustfmt", -- install via rustup
	}

	require("mason").setup({
		max_concurrent_installers = 10,
		PATH = "append", -- prefer local packages if they exist
	})
	require("mason-tool-installer").setup({
		auto_update = true,
		ensure_installed = ensure_installed,
	})
end

return M
