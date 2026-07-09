type TaskFunction = () => Promise<void>;

class MemoryQueue {
    private queue: TaskFunction[] = [];
    private isProcessing: boolean = false;

    public enqueue(task: TaskFunction) {
        this.queue.push(task);
        this.processNext();
    }

    private async processNext() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;
        const task = this.queue.shift();
        
        if (task) {
            try {
                await task();
            } catch (error) {
                console.error("Error processing task:", error);
            }
        }

        this.isProcessing = false;
        // Continue processing if there are more tasks
        this.processNext();
    }
}

export const taskQueue = new MemoryQueue();
