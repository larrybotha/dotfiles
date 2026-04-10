local M = {}

M.setup = function()
	require("mason").setup({
		max_concurrent_installers = 10,
		PATH = "append", -- prefer local packages if they exist
	})

	require("mason-tool-installer").setup({
		auto_update = true,
		ensure_installed = {
			-- dap
			"debugpy",

			-- diagnostics / none-ls | null-ls
			"alex",
			"ansible-lint",
			"biome",
			"codespell",
			"djlint",
			"eslint_d",
			"golangci-lint",
			"hadolint",
			"mypy",
			"pyright",
			"revive",
			"ruff",
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
		},
	})

	vim.api.nvim_create_autocmd("User", {
		pattern = "VeryLazy",
		once = true,
		callback = function()
			vim.inspect("VeryLazy event emitted")
			print("VeryLazy event emitted")
			vim.cmd("MasonToolsUpdate")
		end,
	})
end

return M
