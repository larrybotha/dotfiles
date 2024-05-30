return {
	"aserowy/tmux.nvim",
	config = function()
		local tmux = require("tmux")

		-- we only want this plugin for its tmux-like resizing inside Neovim
		-- TODO: replace vim-tmux-navigator with this plugin
		tmux.setup({
			copy_sync = {
				enabled = false, -- copy sync is slow as heck
			},
			navigation = {
				-- use vim-tmux-navigator directly for navigation
				enable_default_keybindings = false,
			},
			resize = {
				enable_default_keybindings = false,
				-- use the same resize steps as defined in $HOME/.tmux.conf
				resize_step_x = 5,
				resize_step_y = 5,
			},
		})

		-- resize windows in the same way that we do in tmux.conf
		vim.keymap.set("n", "Ò", tmux.resize_right, { desc = "increase window width - <A-S-L> => Ò" })
		vim.keymap.set("n", "Ó", tmux.resize_left, { desc = "decrease window width - <A-S-H> => Ó" })
		vim.keymap.set("n", "", tmux.resize_top, { desc = "increase window height - <A-S-K> => " })
		vim.keymap.set("n", "Ô", tmux.resize_bottom, { desc = "decrease window height - <A-S-J> => Ô" })
	end,
}
