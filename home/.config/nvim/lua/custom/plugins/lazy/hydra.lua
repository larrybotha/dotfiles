return {
	"nvimtools/hydra.nvim",
	event = "VeryLazy",
	config = function()
		local Hydra = require("hydra")
		local diagnostic = vim.diagnostic

		Hydra.setup({ timeout = 2000, hint = false })

		-- TODO: determine why heads are not working for diagnostics
		Hydra({
			body = "]d",
			config = { buffer = true, invoke_on_body = false, on_enter = diagnostic.goto_next },
			heads = { { "d", diagnostic.goto_next } },
			mode = "n",
			name = "go to next diagnostic",
		})

		Hydra({
			body = "[d",
			config = { buffer = true, invoke_on_body = true, on_enter = diagnostic.goto_prev },
			heads = { { "d", diagnostic.goto_prev } },
			mode = "n",
			name = "go to next diagnostic",
		})

		-- TODO: determine how to silence errors if at ends of quickfix list
		Hydra({
			body = "]q",
			config = { invoke_on_body = true, on_enter = vim.cmd.cnext },
			heads = { { "q", vim.cmd.cnext, { silent = true } } },
			mode = "n",
			name = "next quickfix entry",
		})

		Hydra({
			body = "[q",
			config = { invoke_on_body = true, on_enter = vim.cmd.cprevious },
			heads = { { "q", vim.cmd.cprevious, { silent = true } } },
			mode = "n",
			name = "previous quickfix entry",
		})

		Hydra({
			body = "gt",
			config = { invoke_on_body = true, on_enter = vim.cmd.tabnext },
			heads = { { "T", "gT" }, { "t", "gt" } },
			mode = "n",
			name = "tabnext",
		})

		Hydra({
			body = "gT",
			config = { invoke_on_body = true, on_enter = vim.cmd.tabprevious },
			heads = { { "T", "gT" }, { "t", "gt" } },
			mode = "n",
			name = "tabprevious",
		})
	end,
}
