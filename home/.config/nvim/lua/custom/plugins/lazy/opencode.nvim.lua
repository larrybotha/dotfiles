return {
	"nickjvandyke/opencode.nvim",
	dependencies = {
		{
			-- Recommended for `ask()` and `select()`.
			-- Required for `snacks` provider.
			---@module 'snacks'
			"folke/snacks.nvim",
			---@type snacks.Config
			opts = { input = {}, picker = {}, terminal = {} },
		},
	},
	config = function()
		local opencode = require("opencode")
		local set_keymap = vim.keymap.set

		---@type opencode.Opts
		vim.g.opencode_opts = {}

		-- Required for `opts.events.reload`.
		vim.o.autoread = true

		-- Toggle opencode
		set_keymap(
			{ "n", "t" },
			"<leader>ot", -- codespell:ignore
			opencode.toggle,
			{ desc = "Toggle opencode" }
		)

		set_keymap({ "n", "x" }, "<leader>oa", function()
			opencode.ask("@this: ", { submit = true })
		end, { desc = "Ask opencode" })

		set_keymap({ "n", "x" }, "<leader>os", opencode.select, { desc = "Select opencode action" })

		set_keymap({ "n" }, "<leader>ob", function()
			return opencode.prompt("@buffer \n")
		end, { desc = "Add buffer to opencode" })

		set_keymap({ "x" }, "<leader>ol", function()
			return opencode.operator("@this ")
		end, { desc = "Add range to opencode", expr = true })

		set_keymap("n", "<leader>ol", function()
			return opencode.operator("@this ") .. "_"
		end, { desc = "Add line to opencode", expr = true })

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

		-- TODO: determine how to get Hydra-like navigation working
		-- Currently doesn't work because:
		--  - Hydra is synchronous, blocking the event loop until it times out or is
		--    cancelled
		--  - opencode.nvim is asynchronous, so no updates appear in opencode until
		--    the Hydra exits
		set_keymap("n", "<leader>o{", function()
			opencode.command("session.half.page.up")
		end, { desc = "Scroll opencode half page up" })

		set_keymap("n", "<leader>o}", function()
			opencode.command("session.half.page.down")
		end, { desc = "Scroll opencode half page down" })

		set_keymap("n", "<leader>oU", function()
			opencode.command("session.undo")
		end, { desc = "Undo opencode action" })

		set_keymap("n", "<leader>oR", function()
			opencode.command("session.redo")
		end, { desc = "Redo opencode action" })
	end,
}
