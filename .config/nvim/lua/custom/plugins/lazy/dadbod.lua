return {
	"kristijanhusak/vim-dadbod-ui",
	event = "VeryLazy",
	dependencies = {
		{ "tpope/vim-dadbod", event = "VeryLazy" },
		{
			"kristijanhusak/vim-dadbod-completion",
			ft = { "sql", "mysql", "plsql" },
			event = "VeryLazy",
		},
	},
	cmd = {
		"DBUI",
		"DBUIToggle",
		"DBUIAddConnection",
		"DBUIFindBuffer",
	},
	init = function()
		vim.g.db_ui_use_nerd_fonts = 1
		vim.g.db_ui_show_help = 0
	end,
}
