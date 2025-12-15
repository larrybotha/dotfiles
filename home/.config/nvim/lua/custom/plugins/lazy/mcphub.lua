return {
	"ravitemer/mcphub.nvim",

	dependencies = {
		"nvim-lua/plenary.nvim",
	},

	build = "npm install -g mcp-hub@latest",

	config = function()
		require("mcphub").setup({
			port = 9909,
			config = vim.fn.expand("~/.cursor/mcp.json"),

			log = {
				level = vim.log.levels.WARN,
				to_file = false,
				file_path = nil,
				prefix = "MCPHub",
			},
		})
	end,
	enabled = false,
}
