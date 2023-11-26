local obsidian = require("obsidian")

local function get_workspaces(vaults_dir)
	local child_dirs = {}
	local workspaces = {}

	for dir in vim.fs.dir(vaults_dir) do
		local path = vim.fn.expand(string.format("%s/%s", vaults_dir, dir))
		table.insert(child_dirs, path)
	end

	for _, dir in pairs(child_dirs) do
		local path_parts = {}

		for x in string.gmatch(dir, "[^/]+") do
			table.insert(path_parts, x)
		end

		table.insert(workspaces, {
			name = path_parts[#path_parts],
			path = dir,
		})
	end

	return workspaces
end

local vaults_dir = "~/projects/obsidian-vaults"
local options = {
	-- don't manage frontmatter
	disable_frontmatter = true,

	mappings = {
		-- navigate to markdown files using gf - overrides Vim's default behaviour
		["gf"] = {
			action = function()
				return require("obsidian").util.gf_passthrough()
			end,
			opts = { noremap = false, expr = true, buffer = true },
		},
	},

	workspaces = get_workspaces(vaults_dir),
}

obsidian.setup(options)
