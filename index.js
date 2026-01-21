// Prompt Mover Extension for SillyTavern
// Allows moving/copying prompts between OpenAI presets

const extensionName = 'prompt-mover';

// Dynamic imports for third-party compatibility
let getRequestHeaders, callGenericPopup, POPUP_TYPE, openai_setting_names, openai_settings;

async function initImports() {
    const scriptPath = import.meta.url;
    const isThirdParty = scriptPath.includes('/third-party/');
    const base = isThirdParty ? '../../../../' : '../../../';
    
    const scriptModule = await import(base + 'script.js');
    getRequestHeaders = scriptModule.getRequestHeaders;
    
    const popupModule = await import((isThirdParty ? '../../../' : '../../') + 'popup.js');
    callGenericPopup = popupModule.callGenericPopup;
    POPUP_TYPE = popupModule.POPUP_TYPE;
    
    const openaiModule = await import((isThirdParty ? '../../../' : '../../') + 'openai.js');
    openai_setting_names = openaiModule.openai_setting_names;
    openai_settings = openaiModule.openai_settings;
}

let sourcePresetName = '';
let targetPresetName = '';
let sourcePrompts = [];
let targetPrompts = [];
let selectedSourcePromptIndex = -1;
let selectedTargetPromptIndex = -1;
let insertMode = 'after';

/**
 * Load all OpenAI presets
 */
async function loadAllPresets() {
    const presets = {};
    
    if (!openai_settings || !openai_setting_names) {
        return presets;
    }
    
    for (const [name, index] of Object.entries(openai_setting_names)) {
        if (openai_settings[index]) {
            presets[name] = openai_settings[index];
        }
    }
    
    return presets;
}

function getPromptsFromPreset(preset) {
    return preset?.prompts || [];
}

async function savePreset(name, preset) {
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: name,
            preset: preset,
        }),
    });
    
    if (!response.ok) {
        throw new Error('Failed to save preset');
    }
    
    return await response.json();
}

function createPopupHtml(presets) {
    const presetOptions = Object.keys(presets)
        .map(name => `<option value="${name}">${name}</option>`)
        .join('');
    
    return `
        <div id="prompt-mover-container">
            <div class="pm-section">
                <div class="pm-section-title">📤 소스 프리셋 (Source)</div>
                <div class="pm-row">
                    <label>프리셋:</label>
                    <select id="pm-source-preset">
                        <option value="">-- 선택 --</option>
                        ${presetOptions}
                    </select>
                </div>
                <div class="pm-prompt-list" id="pm-source-prompts">
                    <div style="padding: 10px; text-align: center;">프리셋을 선택하세요</div>
                </div>
            </div>
            
            <div class="pm-section">
                <div class="pm-section-title">📥 대상 프리셋 (Target)</div>
                <div class="pm-row">
                    <label>프리셋:</label>
                    <select id="pm-target-preset">
                        <option value="">-- 선택 --</option>
                        ${presetOptions}
                    </select>
                </div>
                <div class="pm-row">
                    <label>삽입:</label>
                    <select id="pm-insert-mode">
                        <option value="after">뒤에</option>
                        <option value="before">앞에</option>
                    </select>
                </div>
                <div class="pm-prompt-list" id="pm-target-prompts">
                    <div style="padding: 10px; text-align: center;">프리셋을 선택하세요</div>
                </div>
            </div>
            
            <div class="pm-actions">
                <button id="pm-btn-copy" disabled>📋 복사</button>
                <button id="pm-btn-move" disabled>✂️ 이동</button>
            </div>
        </div>
    `;
}

function renderPromptsList(container, listId, prompts, selectedIndex, onSelect) {
    const listElement = container.querySelector(`#${listId}`);
    if (!listElement) return;
    
    if (!prompts || prompts.length === 0) {
        listElement.innerHTML = '<div style="padding: 10px; text-align: center;">프롬프트 없음</div>';
        return;
    }
    
    listElement.innerHTML = prompts.map((prompt, index) => {
        const isSelected = index === selectedIndex;
        const name = prompt.name || prompt.identifier || 'Unnamed';
        const identifier = prompt.identifier || '';
        const markerIcon = prompt.marker ? '📍 ' : '';
        
        return `
            <div class="pm-prompt-item ${isSelected ? 'selected' : ''}" data-index="${index}">
                <span class="pm-prompt-index">#${index + 1}</span>
                <span class="pm-prompt-name">${markerIcon}${name}</span>
                <span class="pm-prompt-identifier">[${identifier}]</span>
            </div>
        `;
    }).join('');
    
    listElement.querySelectorAll('.pm-prompt-item').forEach(item => {
        item.addEventListener('click', () => onSelect(parseInt(item.dataset.index)));
    });
}

function updateButtons(container) {
    const copyBtn = container.querySelector('#pm-btn-copy');
    const moveBtn = container.querySelector('#pm-btn-move');
    
    const canCopy = sourcePresetName && targetPresetName && 
                    selectedSourcePromptIndex >= 0 && selectedTargetPromptIndex >= 0;
    const canMove = canCopy && sourcePresetName !== targetPresetName;
    
    if (copyBtn) copyBtn.disabled = !canCopy;
    if (moveBtn) moveBtn.disabled = !canMove;
}

async function performOperation(container, removeFromSource) {
    if (selectedSourcePromptIndex < 0 || selectedTargetPromptIndex < 0) {
        toastr.error('프롬프트를 선택해주세요');
        return;
    }
    
    const sourceIndex = openai_setting_names[sourcePresetName];
    const targetIndex = openai_setting_names[targetPresetName];
    
    if (sourceIndex === undefined || targetIndex === undefined) {
        toastr.error('프리셋을 찾을 수 없습니다');
        return;
    }
    
    const promptToCopy = JSON.parse(JSON.stringify(sourcePrompts[selectedSourcePromptIndex]));
    
    // Handle duplicate identifiers
    const existingIds = targetPrompts.map(p => p.identifier);
    if (existingIds.includes(promptToCopy.identifier)) {
        let counter = 1;
        const baseName = promptToCopy.identifier.replace(/_\d+$/, '');
        while (existingIds.includes(`${baseName}_${counter}`)) counter++;
        promptToCopy.identifier = `${baseName}_${counter}`;
        promptToCopy.name = `${promptToCopy.name} (${counter})`;
    }
    
    const insertPos = insertMode === 'after' ? selectedTargetPromptIndex + 1 : selectedTargetPromptIndex;
    
    // Update target preset
    const targetPreset = JSON.parse(JSON.stringify(openai_settings[targetIndex]));
    targetPreset.prompts = targetPreset.prompts || [];
    targetPreset.prompts.splice(insertPos, 0, promptToCopy);
    
    if (targetPreset.prompt_order) {
        for (const order of targetPreset.prompt_order) {
            if (order.order) {
                order.order.splice(insertPos, 0, { identifier: promptToCopy.identifier, enabled: true });
            }
        }
    }
    
    try {
        await savePreset(targetPresetName, targetPreset);
        openai_settings[targetIndex] = targetPreset;
        
        if (removeFromSource && sourcePresetName !== targetPresetName) {
            const sourcePreset = JSON.parse(JSON.stringify(openai_settings[sourceIndex]));
            const removedId = sourcePrompts[selectedSourcePromptIndex].identifier;
            sourcePreset.prompts.splice(selectedSourcePromptIndex, 1);
            
            if (sourcePreset.prompt_order) {
                for (const order of sourcePreset.prompt_order) {
                    if (order.order) {
                        order.order = order.order.filter(o => o.identifier !== removedId);
                    }
                }
            }
            
            await savePreset(sourcePresetName, sourcePreset);
            openai_settings[sourceIndex] = sourcePreset;
        }
        
        toastr.success(removeFromSource ? '이동 완료' : '복사 완료');
        
        // Refresh lists
        sourcePrompts = getPromptsFromPreset(openai_settings[sourceIndex]);
        targetPrompts = getPromptsFromPreset(openai_settings[targetIndex]);
        selectedSourcePromptIndex = -1;
        selectedTargetPromptIndex = -1;
        
        const srcHandler = idx => {
            selectedSourcePromptIndex = idx;
            renderPromptsList(container, 'pm-source-prompts', sourcePrompts, idx, srcHandler);
            updateButtons(container);
        };
        const tgtHandler = idx => {
            selectedTargetPromptIndex = idx;
            renderPromptsList(container, 'pm-target-prompts', targetPrompts, idx, tgtHandler);
            updateButtons(container);
        };
        
        renderPromptsList(container, 'pm-source-prompts', sourcePrompts, -1, srcHandler);
        renderPromptsList(container, 'pm-target-prompts', targetPrompts, -1, tgtHandler);
        updateButtons(container);
        
    } catch (error) {
        console.error('Operation error:', error);
        toastr.error('작업 실패');
    }
}

async function openPromptMoverPopup() {
    try {
        const presets = await loadAllPresets();
        
        if (Object.keys(presets).length === 0) {
            toastr.warning('프리셋이 없습니다. Chat Completion API를 사용 중인지 확인하세요.');
            return;
        }
        
        // Reset state
        sourcePresetName = '';
        targetPresetName = '';
        sourcePrompts = [];
        targetPrompts = [];
        selectedSourcePromptIndex = -1;
        selectedTargetPromptIndex = -1;
        insertMode = 'after';
        
        const container = document.createElement('div');
        container.innerHTML = createPopupHtml(presets);
        
        const srcHandler = idx => {
            selectedSourcePromptIndex = idx;
            renderPromptsList(container, 'pm-source-prompts', sourcePrompts, idx, srcHandler);
            updateButtons(container);
        };
        
        const tgtHandler = idx => {
            selectedTargetPromptIndex = idx;
            renderPromptsList(container, 'pm-target-prompts', targetPrompts, idx, tgtHandler);
            updateButtons(container);
        };
        
        container.querySelector('#pm-source-preset')?.addEventListener('change', e => {
            sourcePresetName = e.target.value;
            selectedSourcePromptIndex = -1;
            sourcePrompts = sourcePresetName ? getPromptsFromPreset(openai_settings[openai_setting_names[sourcePresetName]]) : [];
            renderPromptsList(container, 'pm-source-prompts', sourcePrompts, -1, srcHandler);
            updateButtons(container);
        });
        
        container.querySelector('#pm-target-preset')?.addEventListener('change', e => {
            targetPresetName = e.target.value;
            selectedTargetPromptIndex = -1;
            targetPrompts = targetPresetName ? getPromptsFromPreset(openai_settings[openai_setting_names[targetPresetName]]) : [];
            renderPromptsList(container, 'pm-target-prompts', targetPrompts, -1, tgtHandler);
            updateButtons(container);
        });
        
        container.querySelector('#pm-insert-mode')?.addEventListener('change', e => {
            insertMode = e.target.value;
        });
        
        container.querySelector('#pm-btn-copy')?.addEventListener('click', () => performOperation(container, false));
        container.querySelector('#pm-btn-move')?.addEventListener('click', () => performOperation(container, true));
        
        await callGenericPopup(container, POPUP_TYPE.TEXT, '', { okButton: '닫기', cancelButton: false, wide: true });
        
    } catch (error) {
        console.error('Popup error:', error);
        toastr.error('Prompt Mover를 열 수 없습니다');
    }
}

function addExtensionPanel() {
    const tryAdd = () => {
        if (document.getElementById('prompt_mover_container')) return true;
        
        const settingsPanel = document.getElementById('extensions_settings2');
        if (!settingsPanel) return false;
        
        const container = document.createElement('div');
        container.id = 'prompt_mover_container';
        container.className = 'extension_container';
        container.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Prompt Mover</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p style="margin: 5px 0;">프리셋 간에 프롬프트를 복사/이동합니다.</p>
                    <div id="pm-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-arrows-left-right"></i>
                        <span>Prompt Mover 열기</span>
                    </div>
                </div>
            </div>
        `;
        container.querySelector('#pm-open-btn').addEventListener('click', openPromptMoverPopup);
        settingsPanel.appendChild(container);
        return true;
    };
    
    if (tryAdd()) return;
    
    // Retry with interval
    let count = 0;
    const timer = setInterval(() => {
        if (tryAdd() || ++count > 50) clearInterval(timer);
    }, 200);
}

function addPromptManagerButton() {
    const tryAdd = () => {
        if (document.getElementById('pm-header-btn')) return;
        const header = document.querySelector('#completion_prompt_manager_header');
        if (!header) return;
        
        const btn = document.createElement('div');
        btn.id = 'pm-header-btn';
        btn.className = 'menu_button menu_button_icon';
        btn.title = 'Prompt Mover';
        btn.innerHTML = '<i class="fa-solid fa-arrows-left-right"></i>';
        btn.style.marginLeft = '5px';
        btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPromptMoverPopup(); });
        header.appendChild(btn);
    };
    
    tryAdd();
    
    const observer = new MutationObserver(tryAdd);
    observer.observe(document.body, { childList: true, subtree: true });
}

// Init
jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        await initImports();
        addExtensionPanel();
        addPromptManagerButton();
        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
