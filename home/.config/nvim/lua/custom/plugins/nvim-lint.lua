local M = {}

M.setup = function()
	local lint = require("lint")

	lint.linters_by_ft = {
		-- General
		ansible = { "ansible_lint" },
		css = { "stylelint" },
		dockerfile = { "hadolint" },
		env = { "dotenv_linter" },
		html = { "djlint" },
		htmldjango = { "djlint" },
		make = { "checkmake" },
		markdown = { "alex", "markdownlint-cli2" },
		nix = { "deadnix" },
		scss = { "stylelint" },
		sql = { "sqlfluff" },
		terraform = { "terraform_validate", "tfsec" },
		vim = { "vint" },

		-- C/C++
		c = { "cppcheck" },
		cpp = { "cppcheck" },

		-- Text/English
		text = { "alex" },

		-- Go
		go = {
			"revive",
			-- "golangci_lint", -- locks UI until file is processed
		},

		-- Python
		python = { "dmypy" },
	}

	-- Setup autocmds to trigger linting
	local lint_augroup = vim.api.nvim_create_augroup("custom-nvim-lint", { clear = true })

	vim.api.nvim_create_autocmd({ "BufWritePost", "BufReadPost" }, {
		group = lint_augroup,

		callback = function()
			lint.try_lint()
			lint.try_lint("codespell")
		end,
	})

	-- More aggressive linting for stdin-capable linters
	vim.api.nvim_create_autocmd({ "InsertLeave" }, {
		group = lint_augroup,
		callback = function()
			-- Only lint with stdin-capable linters on InsertLeave
			lint.try_lint(nil, { filter = "stdin" })
		end,
	})
end

return M
