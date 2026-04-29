return {
	"elmonade/pi-mono.nvim",
	dependencies = {
		{ "folke/snacks.nvim", opts = { input = {}, picker = {}, terminal = {} } },
	},
	config = function()
		vim.g.pi_opts = {
			binary = "pi",
		}

		-- Keymaps
		vim.keymap.set({ "n", "x" }, "<leader>oa", function()
			require("pi-mono").ask("@this: ", { submit = true })
		end, { desc = "Ask pi" })

		vim.keymap.set({ "n", "x" }, "<leader>op", function()
			require("pi-mono").select()
		end, { desc = "Execute pi action" })

		vim.keymap.set({ "n", "t" }, "<leader>ot", function()
			require("pi-mono").toggle()
		end, { desc = "Toggle pi" })
	end,
}
