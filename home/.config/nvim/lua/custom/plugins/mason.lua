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

			-- lsp
			"ansible-language-server",
			"bash-language-server",
			"clangd",
			"cmake-language-server",
			"css-lsp",
			"css-variables-language-server",
			"docker-compose-language-service",
			"dockerfile-language-server",
			"elm-language-server",
			"emmet-ls",
			"eslint-lsp",
			"gitlab-ci-ls",
			"gopls",
			"html-lsp",
			"htmx-lsp",
			"json-lsp",
			"lua-language-server",
			"marksman",
			"rust-analyzer",
			"some-sass-language-server",
			"sqls",
			"svelte-language-server",
			"tailwindcss-language-server",
			"templ",
			"terraform-ls",
			"typescript-language-server",
			"vim-language-server",
			"yaml-language-server",
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
