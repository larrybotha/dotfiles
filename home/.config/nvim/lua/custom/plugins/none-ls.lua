local M = {}

M.setup = function()
	local null_ls = require("null-ls") -- uses null-ls for legacy support
	local diagnostics = null_ls.builtins.diagnostics

	null_ls.setup({
		sources = {
			diagnostics.ansiblelint,
			diagnostics.checkmake,
			diagnostics.deadnix,
			diagnostics.djlint,
			diagnostics.dotenv_linter,
			diagnostics.hadolint,
			diagnostics.markdownlint_cli2,
			diagnostics.sqlfluff,
			diagnostics.stylelint,
			diagnostics.terraform_validate,
			diagnostics.tfsec,
			diagnostics.vint,

			-- c/c++
			diagnostics.cppcheck,

			-- english
			diagnostics.alex,
			diagnostics.codespell,

			-- go
			--diagnostics.golangci_lint, -- locks UI until file is processed
			diagnostics.revive,

			-- python
			--See https://github.com/jose-elias-alvarez/null-ls.nvim/issues/831#issuecomment-1488648192
			--for where this config came from
			diagnostics.mypy.with({
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
					local should_run = not (
						string.find(params.bufname, "fugitive") or string.find(params.bufname, ".venv")
					)

					return should_run
				end,
			}),
		},
	})
end

return M
