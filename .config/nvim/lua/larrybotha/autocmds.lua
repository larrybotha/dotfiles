local create_autocmd = vim.api.nvim_create_autocmd
local SuperCoolGroup = vim.api.nvim_create_augroup("SuperCoolGroup", {})


---
-- Colours
---
local function doTheColours()
  -- Define custom cursor colors highlights
  local opts = {bold=true, bg="black"}
  vim.api.nvim_set_hl(0, "CursorLine", opts)
  vim.api.nvim_set_hl(0, "CursorColumn", opts)

  -- Highlight trailing white space
  vim.api.nvim_set_hl(0, "ExtraWhiteSpace", {bg="red"})
  vim.cmd([[match ExtraWhitespace /\s\+$/]])
end

create_autocmd("ColorScheme", {
  callback = doTheColours,
  desc = "set cursor, column, and extra whitespace colours",
  group = SuperCoolGroup,
  pattern = "*"
})


---
-- Grepping
---
local function grepWithRipGrep(event, opts)
  if not vim.fn.executable("rg") then
    return
  end

  vim.opt.grepprg="rg --vimgrep --hidden --smart-case"
  -- `%f` represents the file name where the match was found
  -- `%l` represents the line number where the match was found
  -- `%c` represents the column number where the match was found
  -- `%m` represents the matched text itself
  vim.opt.grepformat = "%f:%l:%c:%m"

  create_autocmd("QuickFixCmdPost",{
    command = "cwindow",
    desc = "open quickfix after grepping",
    group = SuperCoolGroup,
    nested=true,
    pattern = { "[^l]*" }
  })
  create_autocmd("QuickFixCmdPost",{
    command = "lwindow",
    desc = "open locationlist after grepping",
    group = SuperCoolGroup,
    nested=true,
    pattern = { "l*" }
  })
  --create_autocmd("QuickFixCmdPost",{
  --  command = "redraw",
  --  desc = [[
  --    force a redraw when quickfix list is updated to automatically close
  --    the 'Press Enter' prompt
  --  ]],
  --  group = SuperCoolGroup,
  --  pattern = { "[^l]*", "l*" }
  --})
end

create_autocmd("VimEnter", {
  callback = grepWithRipGrep,
  group = SuperCoolGroup,
  once= true,
  pattern = "*",
  desc = "use ripgrep as the grep program"
})


---
-- Auto-reloading files
---
local function syncExternalFileUpdates(event, opts)
  vim.opt.autoread = true -- update files in Vim that were updated externally

  create_autocmd({"FocusGained", "BufEnter"}, {
    command = "silent! checktime",
    desc = "Evaluate the current file for external file changes when the cursor stop moving",
    group = SuperCoolGroup,
    pattern = "*"
  })

  -- https://vi.stackexchange.com/questions/14315/how-can-i-tell-if-im-in-the-command-window
  create_autocmd({"FocusGained", "BufEnter"}, {
    command = "if mode() == 'n' && getcmdwintype() == '' | checktime | endif",
    desc = "Evaluate the current file for external file changes when the cursor stop moving",
    group = SuperCoolGroup,
    pattern = "*"
  })
end

create_autocmd("VimEnter", {
  callback = syncExternalFileUpdates,
  desc = "automatically update files in Neovim that are updated externally",
  group = SuperCoolGroup,
  once= true,
  pattern = "*"
})


---
-- Delete trailing whitespace on save
---
create_autocmd("BufWritePre", {
  command = "%s/\\s\\+$//e",
  desc = "delete trailing whitespace on save",
  group = SuperCoolGroup,
  pattern ="*",
})


---
-- Jump to last known cursor position
---
create_autocmd("BufReadPost", {
  callback = function()
    local current_line = vim.fn.line("'\"")

    if current_line > 0 and current_line <= vim.fn.line("$") then
      vim.api.nvim_exec('normal g`\" |', {})
    end
  end,
  desc = "jump to last known cursor position after reading file into buffer",
  group = SuperCoolGroup,
  pattern ="*",
})


---
-- Use hybrid line numbers when not in insert mode
---
local function setRelativeNumbers(value)
    if vim.opt.number:get() then
      vim.opt.relativenumber = value
    end
end

create_autocmd({"BufEnter", "FocusGained", "InsertLeave", "WinEnter"}, {
  callback = function() setRelativeNumbers(true) end,
  desc = "enable relative numbers when not in insert mode",
  group = SuperCoolGroup,
  pattern ="*",
})

create_autocmd({"BufLeave", "FocusLost", "InsertEnter", "WinLeave"}, {
  callback = function() setRelativeNumbers(false) end,
  desc = "don't use relative number when in insert mode",
  group = SuperCoolGroup,
  pattern ="*",
})
