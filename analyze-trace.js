#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let inputFile, outputFile, debug = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
        inputFile = args[i + 1];
    } else if (args[i] === '--output' && args[i + 1]) {
        outputFile = args[i + 1];
    } else if (args[i] === '--debug') {
        debug = true;
    }
}

if (!inputFile || !outputFile) {
    console.error('Usage: node analyze-trace.js --input <trace.json> --output <report.csv> [--debug]');
    process.exit(1);
}

// Debug function to analyze trace categories and types
function analyzeTraceMetadata(events) {
    const categories = new Set();
    const taskTypes = new Set();
    const categoryCount = new Map();
    const taskTypeCount = new Map();

    events.forEach(event => {
        // Track categories
        if (event.cat) {
            const cats = event.cat.split(',');
            cats.forEach(cat => {
                categories.add(cat.trim());
                categoryCount.set(cat.trim(), (categoryCount.get(cat.trim()) || 0) + 1);
            });
        }

        // Track task types (event names)
        if (event.name) {
            taskTypes.add(event.name);
            taskTypeCount.set(event.name, (taskTypeCount.get(event.name) || 0) + 1);
        }
    });

    console.log('\n=== Debug Information ===');
    console.log('\nUnique Categories Found:');
    console.log('------------------------');
    Array.from(categories).sort().forEach(cat => {
        console.log(`${cat}: ${categoryCount.get(cat)} occurrences`);
    });

    console.log('\nUnique Task Types Found:');
    console.log('----------------------');
    Array.from(taskTypes).sort().forEach(type => {
        console.log(`${type}: ${taskTypeCount.get(type)} occurrences`);
    });

    // Print some statistics
    console.log('\nStatistics:');
    console.log('-----------');
    console.log(`Total unique categories: ${categories.size}`);
    console.log(`Total unique task types: ${taskTypes.size}`);
    console.log('======================\n');
}

// Main task analysis function
async function analyzeTrace(tracePath, reportPath) {
    try {
        console.log('Reading trace file:', tracePath);
        
        // Check if input file exists
        if (!fs.existsSync(tracePath)) {
            throw new Error(`Input file not found: ${tracePath}`);
        }

        // Read and parse the trace file
        const fileContent = fs.readFileSync(tracePath, 'utf8');
        console.log(`Read ${fileContent.length} bytes from trace file`);
        
        let traceData;
        try {
            traceData = JSON.parse(fileContent);
            console.log('Successfully parsed JSON');
        } catch (e) {
            throw new Error(`Failed to parse JSON: ${e.message}`);
        }

        // Validate trace data structure
        if (!traceData || (!Array.isArray(traceData) && !Array.isArray(traceData.traceEvents))) {
            throw new Error('Invalid trace file format: missing traceEvents array');
        }
        
        const events = Array.isArray(traceData) ? traceData : traceData.traceEvents;
        
        // If debug flag is set, analyze and print metadata
        if (debug) {
            analyzeTraceMetadata(events);
        }

        // Initialize or read existing report
        let existingReport = [];
        if (fs.existsSync(reportPath)) {
            console.log('Reading existing report file');
            const reportContent = fs.readFileSync(reportPath, 'utf8');
            existingReport = parseCSV(reportContent);
        }

        // Process trace events
        console.log('Processing trace events...');
        console.log(`Found ${events.length} events to process`);
        
        const tasks = processTraceEvents(traceData);
        console.log(`Identified ${tasks.length} tasks`);
        
        // Update report with new run
        console.log('Updating report...');
        const updatedReport = updateReport(existingReport, tasks);
        console.log(`Report updated with ${updatedReport.length} rows`);
        
        // Write updated report
        console.log('Writing report to:', reportPath);
        writeReport(reportPath, updatedReport);

    } catch (error) {
        console.error('Error analyzing trace:');
        console.error('- Message:', error.message);
        console.error('- Stack:', error.stack);
        process.exit(1);
    }
}

// Helper function to parse CSV content
function parseCSV(content) {
    if (!content.trim()) return [];
    
    const lines = content.trim().split('\n');
    return lines.map(line => line.split('\t'));
}

// Process trace events to find TBT-influencing tasks
function processTraceEvents(traceData) {
    const events = Array.isArray(traceData) ? traceData : traceData.traceEvents;
    const tasks = new Map();

    // Filter for main thread events and calculate blocking time
    events.forEach(event => {
        if (isPotentialTBTTask(event)) {
            const duration = event.dur / 1000; // Convert microseconds to milliseconds
            const blockingTime = calculateBlockingTime(event);
            const key = getEventKey(event);
            const url = getEventUrl(event);
            
            // Create unique key combining name and URL
            const uniqueKey = `${key}|${url}`;
            
            // Get or create task entry
            let task = tasks.get(uniqueKey) || {
                name: key,
                url: url,
                blockingTime: 0,
                totalDuration: 0,
                occurrences: 0,
                category: event.cat || 'unknown'
            };
            
            // Update task metrics
            task.blockingTime += blockingTime;
            task.totalDuration += duration;
            task.occurrences += 1;
            
            tasks.set(uniqueKey, task);
        }
    });

    return Array.from(tasks.values());
}

// Determine if an event could potentially influence TBT
function isPotentialTBTTask(event) {
    // Categories that can influence TBT
    const tbtCategories = [
        'devtools.timeline',
        'loading',
        'scripting',
        'rendering',
        'painting',
        'v8',
        'v8.execute',
        'blink',
        'benchmark',
        'disabled-by-default-devtools.timeline'
    ];

    // Task types that can influence TBT
    const tbtTaskTypes = [
        // Script execution
        'Script',
        'EvaluateScript',
        'V8.CompileScript',
        'V8.CompileCode',
        'V8.CompileIgnition',
        'V8.CompileEval',
        'FunctionCall',
        'v8.callFunction',
        'TimerFire',
        'EventDispatch',
        'RunTask',
        
        // Layout & Style
        'Layout',
        'UpdateLayoutTree',
        'RecalculateStyles',
        'ParseHTML',
        'ParseAuthorStyleSheet',
        'StyleRecalculation',
        'UpdateLayer',
        'Layerize',
        
        // Paint & Composite
        'Paint',
        'CompositeLayers',
        'UpdateLayerTree',
        'PrePaint',
        
        // Resource handling
        'XHRReadyStateChange',
        'ResourceSendRequest',
        'ResourceReceiveResponse',
        'ResourceFinish'
    ];

    // Helper function to check if a string contains any of the patterns
    const containsAny = (str, patterns) => {
        if (!str) return false;
        return patterns.some(pattern => 
            str.toLowerCase().includes(pattern.toLowerCase())
        );
    };

    return (
        event.ph === 'X' && // Complete events
        event.dur && // Has duration
        (
            // Check for main thread events
            (event.tid === 1 || 
             event.name?.includes('MainThread') ||
             event.cat?.includes('devtools.timeline')) &&
            (
                // Check categories
                (event.cat && tbtCategories.some(cat => 
                    event.cat.split(',').some(c => 
                        c.trim().toLowerCase().includes(cat.toLowerCase())
                    )
                )) ||
                // Check task types with more flexible matching
                (event.name && containsAny(event.name, tbtTaskTypes))
            )
        )
    );
}

// Calculate blocking time (time above 50ms)
function calculateBlockingTime(event) {
    const durationMs = event.dur / 1000; // Convert microseconds to milliseconds
    return durationMs > 50 ? durationMs - 50 : 0;
}

// Get a unique key for the event
function getEventKey(event) {
    return event.name || 'Unknown Task';
}

// Extract URL from event if available
function getEventUrl(event) {
    return event.args?.data?.url || '';
}

// Update report with new run data
function updateReport(existingReport, tasks) {
    // Initialize report with headers if it's empty
    if (existingReport.length === 0) {
        // For new files, we don't need to add -1 columns since this is the first run
        existingReport.push([
            'Task Name',
            'URL',
            'Category',
            'Has Long Tasks',  // New column to track if task ever exceeded 50ms
            'Run 1 (Blocking Time)',
            'Run 1 (Total Duration)',
            'Run 1 (Occurrences)'
        ]);

        // Process tasks for the first run
        tasks.forEach(task => {
            existingReport.push([
                task.name,
                task.url,
                task.category,
                task.blockingTime > 0 ? 'Yes' : 'No',
                task.blockingTime.toFixed(2),
                task.totalDuration.toFixed(2),
                task.occurrences.toString()
            ]);
        });

        return existingReport;
    }

    // For existing reports, continue with the normal process
    const headerRow = existingReport[0];
    const runCount = Math.floor((headerRow.length - 4) / 3); // Subtract fixed columns (Name, URL, Category, Has Long Tasks)
    const nextRunNumber = runCount + 1;

    // Add new run columns to header
    headerRow.push(
        `Run ${nextRunNumber} (Blocking Time)`,
        `Run ${nextRunNumber} (Total Duration)`,
        `Run ${nextRunNumber} (Occurrences)`
    );

    // Create a map of existing tasks with their row indices
    const taskMap = new Map();
    for (let i = 1; i < existingReport.length; i++) {
        const row = existingReport[i];
        const key = `${row[0]}|${row[1]}`; // Combine task name and URL
        taskMap.set(key, i);
    }

    // Create a set to track which tasks were updated in this run
    const updatedTasks = new Set();

    // Process new tasks
    tasks.forEach(task => {
        const taskKey = `${task.name}|${task.url}`;
        let rowIndex = taskMap.get(taskKey);

        if (rowIndex === undefined) {
            // New task, create new row
            rowIndex = existingReport.length;
            const newRow = [
                task.name,
                task.url,
                task.category,
                task.blockingTime > 0 ? 'Yes' : 'No'
            ];
            
            // Fill previous runs with -1
            for (let i = 0; i < runCount; i++) {
                newRow.push('-1', '-1', '-1');
            }
            
            existingReport.push(newRow);
            taskMap.set(taskKey, rowIndex);
        } else {
            // Update Has Long Tasks if this run had blocking time
            if (task.blockingTime > 0) {
                existingReport[rowIndex][3] = 'Yes';
            }
        }

        // Update the row with new run data
        const row = existingReport[rowIndex];
        row.push(
            task.blockingTime.toFixed(2),
            task.totalDuration.toFixed(2),
            task.occurrences.toString()
        );
        
        updatedTasks.add(taskKey);
    });

    // Fill -1 for tasks that didn't appear in this run
    taskMap.forEach((rowIndex, taskKey) => {
        if (!updatedTasks.has(taskKey)) {
            existingReport[rowIndex].push('-1', '-1', '-1');
        }
    });

    return existingReport;
}

// Write the report to CSV
function writeReport(reportPath, report) {
    try {
        // Ensure directory exists
        const dir = path.dirname(reportPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // If file doesn't exist, create it
        // If it exists, read it first to determine if we need to preserve existing data
        let existingContent = '';
        if (fs.existsSync(reportPath)) {
            existingContent = fs.readFileSync(reportPath, 'utf8');
        }

        const content = report.map(row => row.join('\t')).join('\n');
        
        // Only write if content is different
        if (content !== existingContent) {
            fs.writeFileSync(reportPath, content);
            console.log(`Successfully wrote ${report.length} rows to ${reportPath}`);
            
            const stats = fs.statSync(reportPath);
            console.log(`Report file size: ${stats.size} bytes`);
        } else {
            console.log('No changes to write to report file');
        }
    } catch (error) {
        console.error('Error writing report:', error);
        throw error;
    }
}

// Run the analysis
console.log('Starting trace analysis...');
console.log('Input file:', inputFile);
console.log('Output file:', outputFile);
analyzeTrace(inputFile, outputFile); 