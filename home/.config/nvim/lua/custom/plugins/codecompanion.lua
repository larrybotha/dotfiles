---@module "vectorcode"

local cc = require("codecompanion")
local spinner = require("custom.plugins.custom-spinner")

local function claude_code_acp()
	-- requires @zed-industries/claude-code-acp
	return require("codecompanion.adapters").extend("claude_code", {
		env = {
			CLAUDE_CODE_OAUTH_TOKEN = "cmd:pass claude-code/token/neovim",
		},
	})
end

local function gemini_cli_acp()
	-- requires gemini-cli
	return require("codecompanion.adapters").extend("gemini_cli", {
		defaults = {
			auth_method = "gemini-api-key",
		},
		env = {
			GEMINI_API_KEY = "cmd:pass gemini/token/neovim",
		},
	})
end

local function codex_cli_acp()
	-- requires npm dep: @zed-industries/codex-acp
	return require("codecompanion.adapters").extend("codex", {
		env = {
			-- https://platform.openai.com/api-keys
			OPENAI_API_KEY = "cmd:pass openai/codex/token/neovim",
		},
	})
end

cc.setup({
	adapters = {
		http = {
			opts = {
				show_defaults = false,
			},
		},
		acp = {
			claude_code = claude_code_acp,
			codex = codex_cli_acp,
			gemini_cli = gemini_cli_acp,
			opts = { show_defaults = false },
		},
	},
	strategies = {
		chat = {
			adapter = "gemini_cli",
			opts = {
				completion_provider = "blink",
			},
		},
		inline = { adapter = "gemini_cli" },
		agent = { adapter = "gemini_cli" },
	},
	display = {
		chat = {
			show_references = true,
			--show_settings = true,
			show_token_count = true,
		},
	},
	opts = {
		log_level = "ERROR", -- TRACE|DEBUG|ERROR|INFO
	},
	extensions = {
		vectorcode = {
			---@type VectorCode.CodeCompanion.ExtensionOpts
			opts = {
				tool_group = {
					-- this will register a tool group called `@vectorcode_toolbox` that contains all 3 tools
					enabled = true,
					-- a list of extra tools that you want to include in `@vectorcode_toolbox`.
					-- if you use @vectorcode_vectorise, it'll be very handy to include
					-- `file_search` here.
					extras = {},
					collapse = false, -- whether the individual tools should be shown in the chat
				},
				tool_opts = {
					---@type VectorCode.CodeCompanion.ToolOpts
					["*"] = {},
					---@type VectorCode.CodeCompanion.LsToolOpts
					ls = {},
					---@type VectorCode.CodeCompanion.VectoriseToolOpts
					vectorise = {},
					---@type VectorCode.CodeCompanion.QueryToolOpts
					query = {
						max_num = { chunk = -1, document = -1 },
						default_num = { chunk = 50, document = 10 },
						include_stderr = false,
						use_lsp = false,
						no_duplicate = true,
						chunk_mode = false,
						---@type VectorCode.CodeCompanion.SummariseOpts
						summarise = {
							---@type boolean|(fun(chat: CodeCompanion.Chat, results: VectorCode.QueryResult[]):boolean)|nil
							enabled = false,
							adapter = nil,
							query_augmented = true,
						},
					},
					files_ls = {},
					files_rm = {},
				},
			},
		},
	},
})

--vim.keymap.set({ "n", "v" }, "<C-a>", "<cmd>CodeCompanionActions<cr>", { noremap = true, silent = true })
vim.keymap.set({ "n", "v" }, "<leader>a", "<cmd>CodeCompanionChat Toggle<cr>", { noremap = true, silent = true })
vim.keymap.set("v", "ga", "<cmd>CodeCompanionChat Add<cr>", { noremap = true, silent = true })

-- Expand 'cc' into 'CodeCompanion' in the command line
vim.cmd([[cabbrev cc CodeCompanion]])

vim.api.nvim_create_autocmd("User", {
	pattern = {
		"CodeCompanionRequestStarted",
		"CodeCompanionRequestFinished",
	},
	callback = function(args)
		if args.match == "CodeCompanionRequestStarted" then
			spinner.start()
		elseif args.match == "CodeCompanionRequestFinished" then
			spinner.stop()
		end
	end,
})
