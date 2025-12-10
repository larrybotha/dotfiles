return {
	"NickvanDyke/opencode.nvim",
	dependencies = {
		{
			-- snacks is the recommended provider for `ask()` and `select()`
			"folke/snacks.nvim",
			---@type snacks.Config
			opts = { input = {}, picker = {}, terminal = {} },
		},
	},
	config = function()
		local opencode = require("opencode")
		local set_keymap = vim.keymap.set
		local keymap_modes = { "n", "x" }

		---@type opencode.Opts
		vim.g.opencode_opts = {}
		vim.o.autoread = true -- allow reloading buffers when updated by opencode

		set_keymap({ "n", "t" }, "<leader>ot", opencode.toggle, { desc = "Toggle opencode" }) -- codespell:ignore

		set_keymap(keymap_modes, "<leader>oa", function()
			opencode.ask("@this: ", { submit = true })
		end, { desc = "Ask opencode" })

		set_keymap(keymap_modes, "<leader>os", opencode.select, { desc = "Execute opencode action…" })

		set_keymap(keymap_modes, "<leader>op", function()
			opencode.prompt("@this")
		end, { desc = "Add to opencode" })

		set_keymap("n", "<leader>oc", function()
			opencode.command("agent.cycle")
		end, { desc = "Cycle opencode agent" })

		set_keymap("n", "<leader>ogg", function()
			opencode.command("session.first")
		end, { desc = "Go to beginning of opencode session" })

		set_keymap("n", "<leader>oG", function()
			opencode.command("session.last")
		end, { desc = "Go to end of opencode session" })

		set_keymap("n", "<leader>oi", function()
			opencode.command("session.interrupt")
		end, { desc = "Interrupt opencode" })

		set_keymap("n", "<leader>ou", function()
			opencode.command("session.half.page.up")
		end, { desc = "opencode half page up" })

		set_keymap("n", "<leader>od", function()
			opencode.command("session.half.page.down")
		end, { desc = "opencode half page down" })
	end,
}
