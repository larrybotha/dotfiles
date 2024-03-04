local null_ls = require("null-ls") -- uses null-ls for legacy support

local options = {
	sources = {
		null_ls.builtins.diagnostics.ansiblelint,
		null_ls.builtins.diagnostics.checkmake,
		null_ls.builtins.diagnostics.djlint,
		null_ls.builtins.diagnostics.dotenv_linter,
		null_ls.builtins.diagnostics.hadolint,
		null_ls.builtins.diagnostics.markdownlint_cli2,
		null_ls.builtins.diagnostics.sqlfluff,
		null_ls.builtins.diagnostics.stylelint,
		null_ls.builtins.diagnostics.terraform_validate,
		null_ls.builtins.diagnostics.tfsec,
		null_ls.builtins.diagnostics.vint,

		-- english
		null_ls.builtins.diagnostics.alex,
		null_ls.builtins.diagnostics.codespell,

		-- go
		null_ls.builtins.diagnostics.revive,

		-- python
		null_ls.builtins.diagnostics.semgrep.with({ extra_args = { "--config", "auto" } }),
		--See https://github.com/jose-elias-alvarez/null-ls.nvim/issues/831#issuecomment-1488648192
		--for where this config came from
		null_ls.builtins.diagnostics.mypy.with({
			command = "dmypy",
			args = function(params)
				return {
					"run",
					"--timeout",
					"500",
					"--",
					"--hide-error-context",
					"--no-color-output",
					"--show-absolute-path",
					"--show-column-numbers",
					"--show-error-codes",
					"--no-error-summary",
					"--no-pretty",
					"--shadow-file",
					params.bufname,
					params.temp_path,
					params.bufname,
				}
			end,
			prefer_local = ".venv/bin",
			timeout = 50000,
			-- Do not run in fugitive windows, or when inside of a .venv area
			runtime_condition = function(params)
				local should_run = not (string.find(params.bufname, "fugitive") or string.find(params.bufname, ".venv"))

				return should_run
			end,
		}),
	},
}

null_ls.setup(options)
