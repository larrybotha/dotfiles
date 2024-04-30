return {
	"williamboman/mason.nvim",

	config = function()
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
				"yamllint",

				-- formatters
				"cbfmt",
				"djlint",
				"eslint_d",
				"fixjson",
				"goimports",
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

		vim.api.nvim_create_user_command("MasonInstallCustom", function()
			vim.cmd("MasonInstall " .. table.concat(options._custom_ensure_installed, " "))
		end, {})
	end,
}
