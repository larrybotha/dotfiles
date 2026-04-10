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
		markdown = { "alex", "markdownlint" },
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
		python = { "mypy" },
	}

	-- Customize mypy to use dmypy with specific configuration
	-- See https://github.com/jose-elias-alvarez/null-ls.nvim/issues/831#issuecomment-1488648192
	local mypy = lint.linters.mypy
	mypy.cmd = "dmypy"
	mypy.args = {
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
	}

	-- Wrap mypy to skip linting in fugitive buffers and .venv directories
	lint.linters.mypy = require("lint.util").wrap(mypy, function(diagnostic)
		local bufname = vim.api.nvim_buf_get_name(0)
		-- Do not run in fugitive windows, or when inside of a .venv area
		if string.find(bufname, "fugitive") or string.find(bufname, ".venv") then
			return nil -- Exclude this diagnostic
		end

		return diagnostic
	end)

	-- Setup autocmds to trigger linting
	local lint_augroup = vim.api.nvim_create_augroup("custom-nvim-lint", { clear = true })

	vim.api.nvim_create_autocmd({ "BufWritePost", "BufReadPost" }, {
		group = lint_augroup,

		callback = function()
			lint.try_lint()
			lint.try_lint("codespell")
		end,
	})

	vim.api.nvim_create_user_command("DoTheLinters", function()
		local linters = lint.get_running()

		if #linters == 0 then
			return vim.print("󰦕")
		end

		vim.print("󱉶 " .. table.concat(linters, ", ") .. " 🚀")
	end, {})

	-- Optional: More aggressive linting for stdin-capable linters
	--vim.api.nvim_create_autocmd({ "InsertLeave" }, {
	--  group = lint_augroup,
	--  callback = function()
	--    -- Only lint with stdin-capable linters on InsertLeave
	--    lint.try_lint(nil, { filter = "stdin" })
	--  end,
	--})
end

return M
