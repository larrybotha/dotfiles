return {
	"williamboman/mason.nvim",

	dependencies = {
		"WhoIsSethDaniel/mason-tool-installer.nvim",
		"jay-babu/mason-nvim-dap.nvim",
	},

	config = function()
		require("mason").setup({
			max_concurrent_installers = 10,
			PATH = "append", -- prefer local packages if they exist
		})
		require("mason-tool-installer").setup({
			auto_update = true,
			ensure_installed = {
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
			},
		})
	end,
}
