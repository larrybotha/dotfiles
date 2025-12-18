local function bind_diag_jump(n)
	return function()
		vim.diagnostic.jump({ count = n })

		local pos = vim.api.nvim_win_get_cursor(0)
		local diagnostics = vim.diagnostic.get(0, { lnum = pos[1] - 1 })

		if #diagnostics > 0 then
			-- using jump.on_jump doesn't appear to work inside Hydra - manually open
			-- the float window
			vim.diagnostic.open_float({
				bufnr = 0,
				scope = "cursor",
				focus = false,
			})
		end
	end
end
local next_diagnostic = bind_diag_jump(1)
local prev_diagnostic = bind_diag_jump(-1)
local next_qf_entry = function()
	local qf_data = vim.fn.getqflist({
		idx = 0,
		nr = 0,
		size = 0,
	})

	if qf_data.idx < qf_data.size then
		vim.cmd.cnext()
	end
end
local prev_qf_entry = function()
	local qf_data = vim.fn.getqflist({ nr = 0, idx = 0 })

	if qf_data.idx > 1 then
		vim.cmd.cprevious()
	end
end

return {
	"nvimtools/hydra.nvim",
	event = "VeryLazy",
	config = function()
		local Hydra = require("hydra")

		Hydra.setup({ timeout = 2000, hint = false })

		Hydra({
			body = "]d",
			config = {
				buffer = true,
				invoke_on_body = true,
				on_enter = next_diagnostic,
			},
			heads = { { "d", next_diagnostic } },
			mode = "n",
			name = "Hydra: go to next diagnostic",
		})

		Hydra({
			body = "[d",
			config = {
				buffer = true,
				invoke_on_body = true,
				on_enter = prev_diagnostic,
			},
			heads = { { "d", prev_diagnostic } },
			mode = "n",
			name = "Hydra: go to previous diagnostic",
		})

		Hydra({
			body = "]q",
			config = { invoke_on_body = true, on_enter = next_qf_entry },
			heads = { { "q", next_qf_entry, { silent = true } } },
			mode = "n",
			name = "next quickfix entry",
		})

		Hydra({
			body = "[q",
			config = { invoke_on_body = true, on_enter = prev_qf_entry },
			heads = { { "q", prev_qf_entry, { silent = true } } },
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
